import http from 'node:http';
import {createOperations} from './operations.mjs';
import {statistics} from './statistics.mjs';
import {staticFile} from './static-files.mjs';
import {createServiceRuntime,runtimeConfig} from './service-runtime.mjs';
import {previewImport,applyImport,rollbackImport} from './importer.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
function minutes(name,fallback){let value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<=0)throw Error(name+' must be positive');return value*60000}
export const authPolicy={initial:minutes('INITIAL_PASSWORD_MINUTES',1440),restricted:minutes('RESTRICTED_SESSION_MINUTES',10),temporary:minutes('TEMP_PASSWORD_MINUTES',1440)};
let testClock=null,fault=null;
export function setTestClock(value){if(process.env.NODE_ENV!=='test')throw Error('test only');testClock=value}
export function setTestFault(value){if(process.env.NODE_ENV!=='test')throw Error('test only');fault=value}
const nowMs=()=>testClock??Date.now();
const nowISO=()=>new Date(nowMs()).toISOString();
const checkpoint=name=>{if(fault===name)throw Error('injected '+name)};
const atomic=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
const todayAt=at=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date(at));
const root=path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(root,'data'),{recursive:true});
export const db=new DatabaseSync(process.env.DB_PATH||path.join(root,'data','academy.sqlite'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;
CREATE TABLE IF NOT EXISTS records(kind TEXT,id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,student INTEGER,hash TEXT,enabled INTEGER DEFAULT 0,must_change INTEGER DEFAULT 1,temp_hash TEXT,temp_until INTEGER,temp_used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,account TEXT,restricted INTEGER,created INTEGER,touched INTEGER);
CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,result TEXT);
CREATE TABLE IF NOT EXISTS counters(id INTEGER PRIMARY KEY,value INTEGER); INSERT OR IGNORE INTO counters VALUES(1,0);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT,actor TEXT,action TEXT,target INTEGER);
CREATE TABLE IF NOT EXISTS verification(id INTEGER PRIMARY KEY,student INTEGER,at TEXT,actor TEXT,method TEXT);
CREATE TABLE IF NOT EXISTS account_operations(key TEXT PRIMARY KEY,student INTEGER);
CREATE TABLE IF NOT EXISTS number_history(number TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS policy_runs(id INTEGER PRIMARY KEY,at TEXT,status TEXT);
CREATE TABLE IF NOT EXISTS import_batches(id TEXT PRIMARY KEY,fingerprint TEXT,status TEXT,at TEXT,counts TEXT,source TEXT);
CREATE TABLE IF NOT EXISTS import_mapping(batch TEXT,kind TEXT,source_key TEXT,target INTEGER,PRIMARY KEY(batch,kind,source_key));
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS retention_jobs(kind TEXT,target INTEGER,status TEXT,attempts INTEGER,at TEXT,error_code TEXT,PRIMARY KEY(kind,target));
CREATE TABLE IF NOT EXISTS failures(key TEXT PRIMARY KEY,count INTEGER,until INTEGER);
`);
db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('dataset',randomBytes(16).toString('hex'));
const dataset=db.prepare('SELECT value FROM metadata WHERE key=?').get('dataset').value;
const dbPath=process.env.DB_PATH||path.join(root,'data','academy.sqlite');
const journalPath=process.env.RETENTION_JOURNAL_PATH||(dbPath===':memory:'?':memory:':dbPath+'.deletions.sqlite');
db.prepare('ATTACH DATABASE ? AS deletion_journal').run(journalPath);
db.exec('CREATE TABLE IF NOT EXISTS deletion_journal.datasets(dataset TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS deletion_journal.entries(dataset TEXT,kind TEXT,target INTEGER,at TEXT,PRIMARY KEY(dataset,kind,target))');
db.prepare('INSERT OR IGNORE INTO deletion_journal.datasets VALUES(?)').run(dataset);
const accountCols=new Set(db.prepare('PRAGMA table_info(accounts)').all().map(x=>x.name));
for(const [column,type] of [['activated_at','INTEGER'],['initial_until','INTEGER']])if(!accountCols.has(column))db.exec('ALTER TABLE accounts ADD COLUMN '+column+' '+type);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS student_numbers ON records(json_extract(data,'$.number')) WHERE kind='students';
CREATE UNIQUE INDEX IF NOT EXISTS student_accounts ON accounts(student) WHERE student IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_director ON accounts((student IS NULL)) WHERE student IS NULL;
CREATE TRIGGER IF NOT EXISTS record_reference_insert BEFORE INSERT ON records BEGIN
 SELECT CASE WHEN NEW.kind='enrollments' AND (NOT EXISTS(SELECT 1 FROM records WHERE kind='students' AND id=json_extract(NEW.data,'$.student')) OR NOT EXISTS(SELECT 1 FROM records WHERE kind='products' AND id=json_extract(NEW.data,'$.product'))) THEN RAISE(ABORT,'invalid enrollment reference') END;
 SELECT CASE WHEN NEW.kind='lessons' AND NOT EXISTS(SELECT 1 FROM records WHERE kind='enrollments' AND id=json_extract(NEW.data,'$.enrollment') AND json_extract(data,'$.student')=json_extract(NEW.data,'$.student')) THEN RAISE(ABORT,'invalid lesson reference') END;
END;
CREATE TRIGGER IF NOT EXISTS record_reference_update BEFORE UPDATE ON records BEGIN
 SELECT CASE WHEN NEW.kind='enrollments' AND (NOT EXISTS(SELECT 1 FROM records WHERE kind='students' AND id=json_extract(NEW.data,'$.student')) OR NOT EXISTS(SELECT 1 FROM records WHERE kind='products' AND id=json_extract(NEW.data,'$.product'))) THEN RAISE(ABORT,'invalid enrollment reference') END;
 SELECT CASE WHEN NEW.kind='lessons' AND NOT EXISTS(SELECT 1 FROM records WHERE kind='enrollments' AND id=json_extract(NEW.data,'$.enrollment') AND json_extract(data,'$.student')=json_extract(NEW.data,'$.student')) THEN RAISE(ABORT,'invalid lesson reference') END;
END;
CREATE TRIGGER IF NOT EXISTS record_reference_delete BEFORE DELETE ON records BEGIN
 SELECT CASE WHEN OLD.kind='students' AND EXISTS(SELECT 1 FROM records WHERE kind IN ('enrollments','lessons') AND json_extract(data,'$.student')=OLD.id) THEN RAISE(ABORT,'student has related records') END;
 SELECT CASE WHEN OLD.kind='products' AND EXISTS(SELECT 1 FROM records WHERE kind='enrollments' AND json_extract(data,'$.product')=OLD.id) THEN RAISE(ABORT,'product has enrollments') END;
 SELECT CASE WHEN OLD.kind='enrollments' AND EXISTS(SELECT 1 FROM records WHERE kind='lessons' AND json_extract(data,'$.enrollment')=OLD.id) THEN RAISE(ABORT,'enrollment has lessons') END;
END;`);
const hash=p=>{let salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex')};
const verify=(p,h)=>{if(typeof p!=='string'||p.length>128||!h)return false;const [salt,value]=h.split(':');if(!/^[a-f0-9]{128}$/.test(value||''))return false;return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(value,'hex'))};
const digest=t=>createHash('sha256').update(t).digest('hex');
const all=k=>db.prepare('SELECT * FROM records WHERE kind=?').all(k).map(r=>({...JSON.parse(r.data),id:r.id,version:r.version}));
const get=(k,id)=>all(k).find(x=>x.id===Number(id));
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export const operations=createOperations({db,all,get,atomic,fail,event:(...args)=>event(...args),nowMs,checkpoint});
const save=(k,d,id)=>{const {version,...data}=d;delete data.id;if(id){let old=get(k,id);if(!old)fail('항목을 찾을 수 없습니다',404);if(version!==old.version)fail('다른 화면에서 수정되었습니다. 새로고침해 주세요',409);db.prepare('UPDATE records SET data=?,version=version+1 WHERE id=?').run(JSON.stringify(data),id);return get(k,id)}let r=db.prepare('INSERT INTO records(kind,data) VALUES(?,?)').run(k,JSON.stringify(data));return get(k,r.lastInsertRowid)};
const event=(actor,action,target)=>db.prepare('INSERT INTO audit(at,actor,action,target) VALUES(?,?,?,?)').run(new Date().toISOString(),actor,action,target||null);
export function months(value,n){let source=Date.parse(value);if(!Number.isFinite(source))fail('기산 시각 오류');let d=new Date(source+32400000),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);let last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return new Date(d.getTime()-32400000).toISOString()}
function revoke(account){db.prepare('DELETE FROM sessions WHERE account=?').run(account)}
function terminate(s,at=nowISO()){if(s.status==='종료'&&s.delete_due)return;s.status='종료';s.ended_at=at;s.delete_due=months(at,6);save('students',s,s.id);const a=db.prepare('SELECT * FROM accounts WHERE student=?').get(s.id);if(a){revoke(a.id);db.prepare('UPDATE accounts SET enabled=0,temp_hash=NULL WHERE id=?').run(a.id)}}
function reconcile(student,at=nowISO()){
 const s=get('students',student);if(!s||s.status==='종료')return;
 const today=todayAt(at),es=all('enrollments').filter(e=>e.student===s.id&&e.status!=='무효');
 if(es.some(e=>['유효','휴원'].includes(e.status)&&e.start<=today&&(!e.end||e.end>=today)))return;
 const past=es.filter(e=>e.start<=today&&(e.status==='종료'||(e.end&&e.end<today)));
 if(!past.length)return;
 const latest=past.map(e=>e.status==='종료'?e.ended_at||at:new Date(Date.parse(e.end+'T00:00:00+09:00')+86400000).toISOString()).sort().at(-1);
 terminate(s,latest);
}
export function sweep(now=nowISO()){
 const targets=[];db.exec('BEGIN IMMEDIATE');try{
 for(const s of all('students'))reconcile(s.id,now);
 for(const student of all('students').filter(s=>s.status==='종료'&&s.delete_due&&s.delete_due<=now)){
  targets.push(['students',student.id]);job('students',student.id,'진행',now);purgeStudent(student.id);checkpoint('purge-after-delete');
  db.prepare('INSERT OR IGNORE INTO deletion_journal.entries VALUES(?,?,?,?)').run(dataset,'students',student.id,now);job('students',student.id,'완료',now);
 }
 for(const ledger of all('ledgers').filter(l=>l.retain_until<=now)){
  targets.push(['ledgers',ledger.id]);job('ledgers',ledger.id,'진행',now);db.prepare('DELETE FROM records WHERE id=?').run(ledger.id);checkpoint('ledger-after-delete');
  db.prepare('INSERT OR IGNORE INTO deletion_journal.entries VALUES(?,?,?,?)').run(dataset,'ledgers',ledger.id,now);job('ledgers',ledger.id,'완료',now);event('policy','대장 DB 파기',null);
 }
 operations.sweepVisitors(now);operations.refreshEligibility();db.prepare('INSERT INTO policy_runs(at,status) VALUES(?,?)').run(now,'성공');db.prepare('DELETE FROM policy_runs WHERE id NOT IN (SELECT id FROM policy_runs ORDER BY id DESC LIMIT 100)').run();db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');db.prepare('INSERT INTO policy_runs(at,status) VALUES(?,?)').run(now,'실패');for(const [kind,target] of targets)job(kind,target,'실패',now,'PURGE_FAILED');throw e}
}
function job(kind,target,status,at,error=''){
 db.prepare("INSERT INTO retention_jobs VALUES(?,?,?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET status=excluded.status,attempts=retention_jobs.attempts+CASE WHEN excluded.status IN ('진행','실패') THEN 1 ELSE 0 END,at=excluded.at,error_code=excluded.error_code").run(kind,target,status,1,at,error);
}
function purgeStudent(id){
 operations.purgeStudent(id);
 for(const kind of ['lessons','enrollments'])for(const r of all(kind).filter(r=>r.student===id)){db.prepare('DELETE FROM import_mapping WHERE target=?').run(r.id);db.prepare('DELETE FROM audit WHERE target=?').run(r.id);db.prepare('DELETE FROM records WHERE id=?').run(r.id)}
 db.prepare('DELETE FROM import_mapping WHERE target=?').run(id);
 for(const account of db.prepare('SELECT id FROM accounts WHERE student=?').all(id)){revoke(account.id);db.prepare('DELETE FROM failures WHERE substr(key,-length(?))=?').run(':'+account.id,':'+account.id)}
 db.prepare('DELETE FROM accounts WHERE student=?').run(id);db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('students',id);
 db.prepare('DELETE FROM verification WHERE student=?').run(id);db.prepare('DELETE FROM account_operations WHERE student=?').run(id);db.prepare('DELETE FROM audit WHERE target=?').run(id);
 // Retry records contain IDs/digests only. Purge all on student deletion so related retry keys cannot survive.
 db.prepare('DELETE FROM operations').run();event('policy','일반기록 DB 파기',null);
}
export function applyDeletionJournal(){return atomic(()=>{let count=0;for(const entry of db.prepare('SELECT * FROM deletion_journal.entries WHERE dataset=?').all(dataset)){
 if(entry.kind==='students'){if(get('students',entry.target)){purgeStudent(entry.target);count++}}
 else if(entry.kind==='ledgers'){count+=Number(db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('ledgers',entry.target).changes)}
 else if(entry.kind==='visitors'){count+=Number(db.prepare('SELECT count(*) n FROM op_visitors WHERE id=?').get(entry.target).n);operations.purgeVisitor(entry.target)}
 }operations.restored();db.exec('DELETE FROM sessions; UPDATE accounts SET temp_hash=NULL,temp_until=NULL,temp_used=1');return {removed:count,dataset}})}
export function inspectIntegrity(){
 const errors=operations.integrity();for(const e of all('enrollments'))if(!get('students',e.student)||!get('products',e.product))errors.push('enrollment:'+e.id);
 for(const l of all('lessons')){let e=get('enrollments',l.enrollment);if(!get('students',l.student)||!e||e.student!==l.student||l.date<e.start||(e.end&&l.date>e.end))errors.push('lesson:'+l.id)}
 for(const a of db.prepare('SELECT * FROM accounts WHERE student IS NOT NULL').all())if(!get('students',a.student)||get('students',a.student).number!==a.id)errors.push('account:'+a.student);
 const students=all('students'),numbers=students.map(x=>x.number);if(new Set(numbers).size!==numbers.length)errors.push('duplicate-number');
 for(const student of students){const es=all('enrollments').filter(e=>e.student===student.id&&e.status!=='무효');for(let i=0;i<es.length;i++)for(let j=i+1;j<es.length;j++)if(es[i].start<=(es[j].end||'9999-12-31')&&es[j].start<=(es[i].end||'9999-12-31'))errors.push('overlap:'+student.id)}
 return {ok:!errors.length&&db.prepare('PRAGMA integrity_check').get().integrity_check==='ok',errors};
}
export function seed(){if(db.prepare('SELECT count(*) n FROM accounts').get().n)return;db.prepare('UPDATE counters SET value=max(value,742) WHERE id=1').run();db.prepare('INSERT INTO accounts(id,hash,enabled,must_change) VALUES(?,?,1,0)').run('director-demo',hash('Demo-Director-2026!'));let p=save('products',{name:'피아노 개인 레슨',axis:'성인 스튜디오',duration:'50분',status:'사용'});let s=save('students',{number:'MBR-000742',name:'가상 수강생',axis:'성인 스튜디오',status:'재원',song:'월광 소나타',goal:'편안한 손 모양과 일정한 박자로 연주하기',contact:'',guardian:'',guardian_contact:'',minor:false});db.prepare('INSERT OR IGNORE INTO number_history VALUES(?)').run(s.number);db.prepare('INSERT INTO accounts(id,student,hash,enabled) VALUES(?,?,?,1)').run(s.number,s.id,hash('1234'));let e=save('enrollments',{student:s.id,product:p.id,product_name:p.name,start:'2026-09-01',end:'',division:'교습소',axis:s.axis,schedule:'토요일 14:00',status:'유효'});save('lessons',{student:s.id,enrollment:e.id,date:'2026-10-02',time:'14:00',status:'완료',type:'정규',song:'월광 소나타',task:'왼손 반주를 천천히 3번 연습해 주세요',next_goal:'프레이즈 연결하기',internal:'합성 내부 메모',published:true});}
if(process.env.APP_MODE!=='production')seed();
db.prepare('UPDATE accounts SET activated_at=?,initial_until=? WHERE student IS NOT NULL AND must_change=1 AND hash IS NOT NULL AND initial_until IS NULL').run(nowMs(),nowMs()+authPolicy.initial);
for(const r of all('students'))db.prepare('INSERT OR IGNORE INTO number_history VALUES(?)').run(r.number);
for(const r of db.prepare('SELECT key,result FROM operations').all()){let d=JSON.parse(r.result);if(d.id)db.prepare('UPDATE operations SET result=? WHERE key=?').run(JSON.stringify({id:d.id,...(d.fingerprint?{fingerprint:d.fingerprint}:{})}),r.key)}
const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const fields={students:['number','name','axis','status','song','goal','contact','guardian','guardian_contact','minor','ended_at','delete_due'],products:['name','axis','duration','status'],enrollments:['student','product','product_name','start','end','division','axis','schedule','status','ended_at'],lessons:['student','enrollment','date','time','status','type','song','task','next_goal','internal','published','reason']};
function clean(k,d,id){if(!d||typeof d!=='object'||Array.isArray(d))fail('입력 형식 오류');let old=id&&get(k,id);if(fields[k]){for(let key of Object.keys(d))if(![...fields[k],'id','version','operation_id'].includes(key))fail('허용되지 않은 입력 항목');if(k==='enrollments'&&d.ended_at!==undefined&&d.ended_at!==old?.ended_at)fail('종료 효력은 서버가 계산합니다');if(k==='students'){for(let key of ['ended_at','delete_due'])if(d[key]!==undefined&&d[key]!==old?.[key])fail('보존 기한은 서버가 계산합니다')}for(let key of ['minor','published'])if(key in d&&typeof d[key]!=='boolean')fail('참/거짓 값을 확인해 주세요');for(let key of ['student','product','enrollment'])if(key in d&&!Number.isSafeInteger(d[key]))fail('연결 ID 오류');for(let key of fields[k])if(!['minor','published','student','product','enrollment'].includes(key)&&d[key]!==undefined&&d[key]!==null&&typeof d[key]!=='string')fail('문자 입력을 확인해 주세요')}}

function validate(k,d,id){clean(k,d,id);for(let v of Object.values(d))if(typeof v==='string'&&v.length>5000)fail('입력은 5,000자 이내입니다');
 if(k==='students'){if(!d.name?.trim()||!['성인 스튜디오','개인과외'].includes(d.axis)||!['재원','휴원','종료'].includes(d.status))fail('이름·운영축·상태를 확인해 주세요');if(id&&d.number!==get(k,id).number)fail('등록번호는 일반 수정할 수 없습니다')}
 if(k==='products'){if(!['사용','종료'].includes(d.status)||!d.name?.trim()||!['성인 스튜디오','개인과외'].includes(d.axis))fail('상품명·운영축을 확인해 주세요');if(all(k).some(p=>p.id!==Number(id)&&p.name===d.name&&p.axis===d.axis))fail('같은 운영축의 상품명이 중복됩니다')}
 if(k==='enrollments'){if(!['유효','휴원','종료','무효'].includes(d.status))fail('수강 상태 오류');let s=get('students',d.student),p=get('products',d.product);if(!s||!p)fail('학생·상품 참조 오류');if(!id&&p.status!=='사용')fail('종료 상품은 등록할 수 없습니다');if(!['교습소','개인과외교습자'].includes(d.division))fail('관리 구분을 선택해 주세요');for(let date of [d.start,d.end].filter(Boolean))if(!validDate(date))fail('날짜를 확인해 주세요');if(!d.start||(d.end&&d.end<d.start))fail('수강기간을 확인해 주세요');if(d.status==='종료'&&(!d.end||d.end>todayAt(nowISO())))fail('종료 수강은 오늘 이전의 종료일이 필요합니다');if(d.status!=='무효'&&all(k).some(e=>e.id!==Number(id)&&e.student===d.student&&e.status!=='무효'&&e.start<=(d.end||'9999-12-31')&&d.start<=(e.end||'9999-12-31')))fail('같은 학생의 수강기간이 겹칩니다',409);if(id&&all('lessons').some(l=>l.enrollment===Number(id)&&(l.date<d.start||(d.end&&l.date>d.end))))fail('연결된 수업이 변경 기간 밖에 있습니다');if(id&&(d.student!==get(k,id).student||d.product!==get(k,id).product))fail('학생·상품 변경은 새 수강등록으로 처리해 주세요');d.product_name=id?get(k,id).product_name:p.name;d.axis=id?get(k,id).axis:s.axis}
 if(k==='lessons'){let e=get('enrollments',d.enrollment);if(!e||e.student!==d.student||d.date<e.start||(e.end&&d.date>e.end)||e.status==='무효')fail('수강기간·학생 연결을 확인해 주세요');if(!validDate(d.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time))fail('날짜·시간을 확인해 주세요');if(!['임시','예정','완료','취소','무효'].includes(d.status))fail('수업상태 오류');if(all(k).some(l=>l.id!==Number(id)&&l.student===d.student&&l.date===d.date&&l.time===d.time&&l.status!=='무효'))fail('동일 시간 수업이 있습니다',409);if(!['정규','보강'].includes(d.type))fail('수업유형 오류');if(id&&get(k,id).published)d.published=false;if(d.published&&d.status!=='완료')fail('완료 수업만 공개할 수 있습니다');if(id&&get(k,id).status!==d.status&&!d.reason?.trim())fail('상태 변경 사유를 입력해 주세요')}
}
export function initializeDirector(id,password){if(typeof id!=='string'||!id.trim()||id.length>100||id.startsWith('MBR-')||id==='director-demo'||typeof password!=='string'||password.length<16||password.length>128)fail('원장 아이디와 16~128자 비밀번호를 확인해 주세요');return atomic(()=>{if(db.prepare('SELECT 1 FROM accounts WHERE student IS NULL').get())fail('원장 계정이 이미 있습니다',409);db.prepare('INSERT INTO accounts(id,hash,enabled,must_change) VALUES(?,?,1,0)').run(id.trim(),hash(password));event('setup','원장 최초 설정',null);return {ok:true}})}
export function recoverDirector(id,password,method){if(typeof password!=='string'||password.length<16||password.length>128||typeof method!=='string'||!method.trim()||method.length>200)fail('새 원장 비밀번호·본인확인 방법을 확인해 주세요');return atomic(()=>{const account=db.prepare('SELECT * FROM accounts WHERE id=? AND student IS NULL').get(id);if(!account)fail('원장 계정 없음',404);db.prepare('UPDATE accounts SET hash=?,enabled=1,must_change=0,temp_hash=NULL WHERE id=?').run(hash(password),id);revoke(id);event('offline-recovery','원장 본인확인 복구: '+method.trim(),null);return {ok:true,sessions_revoked:true}})}
export const importBatch=input=>applyImport({db,save,validate,event,atomic},input);
export const undoImport=batch=>rollbackImport({db,atomic,event},batch);
export const server=http.createServer(async(req,res)=>{const reply=(status,data)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:JSON.stringify(data))};try{let url=new URL(req.url,'http://localhost');if(['/healthz','/readyz'].includes(url.pathname)){if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'GET 상태 조회가 필요합니다'});const readiness=url.pathname==='/readyz',data=runtime.publicHealth(readiness);return reply(readiness?data.status==='ready'?200:503:runtime.stopping?503:200,data)}if(runtime.stopping){res.setHeader('Connection','close');return reply(503,{error:'서버 점검 중입니다. 잠시 후 다시 시도해 주세요.'})}if(!url.pathname.startsWith('/api/')){const file=staticFile(root,url.pathname,req.method);res.writeHead(file.status,{'Content-Type':file.type,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store'});return res.end(req.method==='HEAD'?undefined:file.body)}
 if(!['GET','POST','PUT','DELETE'].includes(req.method))fail('허용되지 않은 요청 방식',405);let b={};if(req.method!=='GET'){if(req.headers.origin&&req.headers.origin!==(process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`))fail('요청 출처 오류',403);if(process.env.APP_MODE==='production'&&req.headers.origin!==process.env.PUBLIC_ORIGIN)fail('요청 출처 오류',403);let raw='';for await(let c of req){raw+=c;if(raw.length>100000)fail('요청이 너무 큽니다',413)}try{b=JSON.parse(raw||'{}')}catch{fail('입력 형식 오류')}}sweep();if(req.method==='GET'&&['/api/login','/api/password','/api/logout'].includes(url.pathname))fail('POST 요청이 필요합니다',405);
 const issue=(a,restricted)=>{let t=randomBytes(32).toString('hex'),now=nowMs();db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(t),a.id,+restricted,now,now);res.setHeader('Set-Cookie',`session=${t}; HttpOnly; SameSite=Strict; Path=/${process.env.APP_MODE==='production'?'; Secure':''}`);return {role:a.student?'student':'director',restricted:!!restricted}};
 if(url.pathname==='/api/login'){if(typeof b.id!=='string'||!b.id.trim()||b.id.length>100||typeof b.password!=='string'||b.password.length>128||!['student','director'].includes(b.mode))fail('아이디 또는 비밀번호를 확인해 주세요',401);b.id=b.id.trim();let key=req.socket.remoteAddress+':'+String(b.id).slice(0,100),f=db.prepare('SELECT * FROM failures WHERE key=?').get(key);if(f&&f.until>nowMs())fail('잠시 후 다시 시도해 주세요',429);let a=db.prepare('SELECT * FROM accounts WHERE id=?').get(String(b.id));let temp=a?.temp_hash&&a.temp_until>nowMs()&&!a.temp_used&&verify(b.password,a.temp_hash);if(!a||!a.enabled||(a.student&&get('students',a.student)?.status==='종료')||(!temp&&a.must_change&&(!a.initial_until||a.initial_until<=nowMs()))||Boolean(a.student)!==(b.mode!=='director')||(!temp&&!verify(b.password,a.hash))){let count=(f?.count||0)+1;db.prepare('INSERT OR REPLACE INTO failures VALUES(?,?,?)').run(key,count,count>=5?nowMs()+900000:0);fail('아이디 또는 비밀번호를 확인해 주세요',401)}db.prepare('DELETE FROM failures WHERE key=?').run(key);return reply(200,atomic(()=>{if(temp){let used=db.prepare('UPDATE accounts SET temp_used=1,hash=NULL WHERE id=? AND temp_used=0 AND temp_until>?').run(a.id,nowMs());if(!used.changes)fail('아이디 또는 비밀번호를 확인해 주세요',401)}checkpoint('login-after-consume');const fresh=db.prepare('SELECT * FROM accounts WHERE id=?').get(a.id);if(!fresh?.enabled||(fresh.student&&get('students',fresh.student)?.status==='종료'))fail('아이디 또는 비밀번호를 확인해 주세요',401);if(!temp&&!verify(b.password,fresh.hash))fail('아이디 또는 비밀번호를 확인해 주세요',401);return issue(fresh,temp||fresh.must_change)}))}
 let token=/session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];let session=token&&db.prepare('SELECT * FROM sessions WHERE token=?').get(digest(token));if(!session||nowMs()-session.touched>1800000||nowMs()-session.created>43200000||(session.restricted&&(nowMs()-session.created>=authPolicy.restricted)))fail('로그인이 필요합니다',401);let a=db.prepare('SELECT * FROM accounts WHERE id=?').get(session.account);if(!a?.enabled||(a.student&&get('students',a.student)?.status==='종료'))fail('계정이 비활성화되었습니다',401);db.prepare('UPDATE sessions SET touched=? WHERE token=?').run(nowMs(),session.token);
 if(url.pathname==='/api/logout'){revoke(a.id);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return reply(200,{ok:true})}
 if(url.pathname==='/api/me')return reply(200,{role:a.student?'student':'director',restricted:!!session.restricted});
 if(url.pathname==='/api/password'){if(typeof b.password!=='string'||b.password.length<10||b.password.length>128||b.password==='1234'||b.password!==b.confirm)fail('새 비밀번호는 10~128자이며 확인값과 같아야 합니다');if(!session.restricted&&!verify(b.current,a.hash))fail('현재 비밀번호를 확인해 주세요',403);if(verify(b.password,a.hash))fail('기존 비밀번호와 다른 값을 사용해 주세요');return reply(200,atomic(()=>{db.prepare('UPDATE accounts SET hash=?,must_change=0,temp_hash=NULL,initial_until=NULL,temp_until=NULL WHERE id=?').run(hash(b.password),a.id);checkpoint('password-after-update');revoke(a.id);return issue(a,false)}))}
 if(session.restricted)fail('비밀번호 변경을 먼저 완료해 주세요',403);
 if(url.pathname.startsWith('/api/student')){if(req.method!=='GET')fail('GET 요청이 필요합니다',405);if(!a.student)fail('학생 계정이 필요합니다',403);let requested=url.searchParams.get('id');if(requested&&Number(requested)!==a.student)fail('본인 정보만 조회할 수 있습니다',403);let s=get('students',a.student);let lessons=all('lessons').filter(l=>l.student===s.id&&l.published&&l.status==='완료').sort((x,y)=>(y.date+y.time).localeCompare(x.date+x.time)||y.id-x.id).map(l=>({id:l.id,date:l.date,time:l.time,status:l.status,type:l.type,song:l.song,task:l.task,next_goal:l.next_goal}));if(url.pathname.startsWith('/api/student/lessons/')){const lesson=lessons.find(l=>l.id===Number(url.pathname.split('/').at(-1)));if(!lesson)fail('공개 수업을 찾을 수 없습니다',404);return reply(200,lesson)}
 if(url.pathname==='/api/student/lessons'){let page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('size')||10),month=url.searchParams.get('month')||'';if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<1||size>50||(month&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))fail('조회 범위를 확인해 주세요');let items=lessons.filter(l=>!month||l.date.startsWith(month));return reply(200,{items:items.slice((page-1)*size,page*size),total:items.length,page,size})}
 if(url.pathname!=='/api/student')fail('요청한 정보를 찾을 수 없습니다',404);let today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());let e=all('enrollments').find(e=>e.student===s.id&&['유효','휴원'].includes(e.status)&&e.start<=today&&(!e.end||e.end>=today));return reply(200,{name:s.name,number:s.number,status:s.status,song:s.song,goal:s.goal,enrollment:e?{product:e.product_name,schedule:e.schedule,start:e.start,end:e.end}:null,lessons:lessons.slice(0,1),updated_at:new Date().toISOString()})}
 if(a.student)fail('원장 권한이 필요합니다',403);
 let parts=url.pathname.split('/').filter(Boolean),k=parts[2],id=parts[3];if(parts[1]!=='admin')fail('요청 오류',404);
 if(k==='runtime'){if(req.method!=='GET'||id)fail('GET 실행 상태 조회가 필요합니다',405);return reply(200,runtime.snapshot())}
 if(k==='statistics'){if(req.method!=='GET'||id)fail('GET 통계 조회가 필요합니다',405);return reply(200,statistics(db,{anchor:url.searchParams.get('anchor')??undefined,period:url.searchParams.get('period')??'7d',now:nowMs()}))}
 if(['dashboard','calendar','calendar-preview','repeat-preview','repeat','visitors','visitor-link','alert-policy','alerts','alerts-run','alerts-reconcile','alerts-retry'].includes(k))return reply(200,operations.route(k,id,req.method,b,url,a.id));
 if(k==='audit')return reply(200,db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all());
 if(k==='accounts'){
  const student=get('students',id);if(!student)fail('학생 없음',404);
  if(req.method==='GET'){const account=db.prepare('SELECT * FROM accounts WHERE student=?').get(student.id);return reply(200,{enabled:!!account?.enabled,must_change:!!account?.must_change,initial_until:account?.initial_until||null,temp_until:account?.temp_until||null,temp_used:!!account?.temp_used})}
  if(req.method!=='POST')fail('POST 요청이 필요합니다',405);
  if(typeof b.operation_id!=='string'||!b.operation_id||b.operation_id.length>100)fail('발급 작업번호가 필요합니다');
  if(b.verified!==true||typeof b.method!=='string'||!b.method.trim()||b.method.length>200)fail('본인확인 방법을 기록해 주세요');
  if(student.status==='종료')fail('재등록 후 본인확인을 거쳐 재활성화해 주세요');
  const result=atomic(()=>{
   let replay=db.prepare('SELECT * FROM account_operations WHERE key=?').get(b.operation_id);
   if(replay){if(replay.student!==student.id)fail('다른 학생에 사용한 작업번호입니다',409);return {replayed:true,notice:'이미 처리한 발급입니다. 원문을 확인하지 못했다면 새 발급을 요청하세요'}}
   let account=db.prepare('SELECT * FROM accounts WHERE student=?').get(student.id),result;
   db.prepare('INSERT INTO verification(student,at,actor,method) VALUES(?,?,?,?)').run(student.id,nowISO(),a.id,b.method.trim());
   checkpoint('account-after-verification');
   if(!account||(account.must_change&&account.hash&&!account.temp_hash)){
    if(account)revoke(account.id);
    db.prepare('INSERT INTO accounts(id,student,hash,enabled,must_change,activated_at,initial_until) VALUES(?,?,?,1,1,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,enabled=1,must_change=1,activated_at=excluded.activated_at,initial_until=excluded.initial_until,temp_hash=NULL,temp_until=NULL,temp_used=0').run(student.number,student.id,hash('1234'),nowMs(),nowMs()+authPolicy.initial);
    result={initial:true,initial_until:nowMs()+authPolicy.initial};event(a.id,'본인확인 계정 활성화',student.id);
   }else{
    revoke(account.id);const temporary=randomBytes(12).toString('base64url');
    db.prepare('UPDATE accounts SET enabled=1,hash=NULL,temp_hash=?,temp_until=?,temp_used=0,initial_until=NULL WHERE id=?').run(hash(temporary),nowMs()+authPolicy.temporary,account.id);
    result={temporary,notice:'한 번만 표시됩니다. 유효기간 내 1회 사용 후 새 비밀번호를 설정하세요',temp_until:nowMs()+authPolicy.temporary};event(a.id,'본인확인 임시 비밀번호 발급',student.id);
   }
   checkpoint('account-after-credential');db.prepare('INSERT INTO account_operations VALUES(?,?)').run(b.operation_id,student.id);return result;
  });return reply(200,result);
 }
 if(k==='retention'){sweep();return reply(200,{ok:true,runs:db.prepare('SELECT * FROM policy_runs ORDER BY id DESC LIMIT 20').all(),jobs:db.prepare('SELECT * FROM retention_jobs ORDER BY at DESC LIMIT 100').all(),ledger_ready:false,notice:'실제 대장 정책 미검수 / DB 외 사본 파기 미검수'})}
 if(k==='import-preview'){if(b.source)return reply(200,previewImport(db,b));if(!Array.isArray(b.rows))fail('rows 배열이 필요합니다');let seen=new Set;return reply(200,b.rows.map((r,i)=>{let errors=[];if(!/^MBR-\d{6}$/.test(r.number))errors.push('번호 형식');if(!r.name?.trim())errors.push('이름 누락');if(seen.has(r.number)||all('students').some(s=>s.number===r.number))errors.push('중복 번호');seen.add(r.number);if(!r.division||!r.start)errors.push('관리 구분·시작일 검수 필요');return {row:i+1,number:r.number,name:r.name,errors,status:errors.length?'보류':'실행 전 검수'}}))}
 if(k==='number-change'){
 if(req.method!=='POST')fail('POST 요청이 필요합니다',405);
 if(typeof b.operation_id!=='string'||!b.operation_id||b.operation_id.length>100)fail('정정 작업번호가 필요합니다');
 const fingerprint=digest(JSON.stringify({student:Number(id),number:b.number,reason:b.reason,version:b.version}));
 const result=atomic(()=>{const key='number-change:'+b.operation_id,op=db.prepare('SELECT result FROM operations WHERE key=?').get(key);
 if(op){const saved=JSON.parse(op.result);if(saved.fingerprint!==fingerprint)fail('작업번호에 다른 입력을 사용할 수 없습니다',409);const current=get('students',saved.id);if(!current)fail('정정 대상이 파기되었습니다',410);return current}
 let old=get('students',id);if(!old)fail('학생 없음',404);if(b.version!==old.version)fail('버전 충돌',409);
 if(typeof b.number!=='string'||!/^MBR-\d{6}$/.test(b.number)||db.prepare('SELECT * FROM number_history WHERE number=?').get(b.number)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>200)fail('번호 형식·사용 이력·변경 사유를 확인해 주세요');
 const account=db.prepare('SELECT * FROM accounts WHERE student=?').get(old.id);if(account){revoke(account.id);db.prepare('UPDATE accounts SET id=?,temp_hash=NULL,temp_until=NULL WHERE student=?').run(b.number,old.id)}
 old.number=b.number;let r=save('students',old,old.id);db.prepare('INSERT INTO number_history VALUES(?)').run(b.number);db.prepare('UPDATE counters SET value=max(value,?) WHERE id=1').run(Number(b.number.slice(4)));event(a.id,'등록번호 변경: '+b.reason.trim(),old.id);
 db.prepare('INSERT INTO operations VALUES(?,?)').run(key,JSON.stringify({id:r.id,fingerprint}));checkpoint('number-after-update');return r;
 });return reply(200,result);
 }
 if(k==='re-enroll'){
 if(req.method!=='POST'||typeof b.operation_id!=='string'||!b.operation_id||b.operation_id.length>100)fail('재등록 작업번호가 필요합니다');
 if(b.verified!==true||typeof b.method!=='string'||!b.method.trim()||b.method.length>200)fail('재등록 본인확인 방법이 필요합니다');
 const fingerprint=digest(JSON.stringify(b));const result=atomic(()=>{
  const key='re-enroll:'+b.operation_id,op=db.prepare('SELECT result FROM operations WHERE key=?').get(key);if(op){const old=JSON.parse(op.result);if(old.fingerprint!==fingerprint)fail('같은 작업번호의 입력이 다릅니다',409);const r=get('enrollments',old.id);if(!r)fail('재등록 대상이 파기되었습니다',410);return r}
  let student=get('students',id);if(!student)fail('파기한 학생은 새 번호로 등록해 주세요',404);if(student.version!==b.version)fail('학생 버전 충돌',409);if(student.status!=='종료')fail('종료생 재등록 전용 작업입니다');
  if(b.start!==todayAt(nowISO()))fail('즉시 재등록 시작일은 KST 오늘이어야 합니다. 미래 등록은 계정 활성화와 별도 검수하세요');
  const end=new Date(Date.parse(b.start)-86400000).toISOString().slice(0,10);
  for(const old of all('enrollments').filter(e=>e.student===student.id&&e.status!=='무효'&&(!e.end||e.end>=b.start))){const prior={...old,end};validate('enrollments',prior,old.id);save('enrollments',prior,old.id)}
  const data={student:student.id,product:b.product,start:b.start,end:b.end||'',division:b.division,schedule:b.schedule||'',status:'유효'};validate('enrollments',data);const r=save('enrollments',data);
  student.status='재원';student.ended_at=null;student.delete_due=null;save('students',student,student.id);
  db.prepare('INSERT INTO verification(student,at,actor,method) VALUES(?,?,?,?)').run(student.id,nowISO(),a.id,b.method.trim());
  db.prepare('INSERT INTO operations VALUES(?,?)').run(key,JSON.stringify({id:r.id,fingerprint}));event(a.id,'본인확인 재등록: 계정 재활성화 별도 필요',student.id);checkpoint('reregister-after-save');return r;
 });return reply(200,result);
 }
 if(k==='transition'){if(req.method!=='POST'||!b.operation_id)fail('전환 작업번호가 필요합니다');db.exec('BEGIN IMMEDIATE');try{let key='transition:'+b.operation_id,op=db.prepare('SELECT result FROM operations WHERE key=?').get(key);if(op){db.exec('COMMIT');return reply(200,get('enrollments',JSON.parse(op.result).id))}let old=get('enrollments',id);if(!old||old.version!==b.version)fail('기존 수강 버전 충돌',409);if(!validDate(b.start))fail('시작일 오류');let end=new Date(Date.parse(b.start)-86400000).toISOString().slice(0,10);let prior={...old,end};validate('enrollments',prior,old.id);save('enrollments',prior,old.id);let next={student:old.student,product:b.product,start:b.start,end:b.end||'',division:b.division,schedule:b.schedule||'',status:'유효'};validate('enrollments',next);let r=save('enrollments',next);db.prepare('INSERT INTO operations VALUES(?,?)').run(key,JSON.stringify({id:r.id}));event(a.id,'상품 전환',r.id);db.exec('COMMIT');return reply(200,r)}catch(e){db.exec('ROLLBACK');throw e}}
 if(!['students','products','enrollments','lessons','ledgers'].includes(k))fail('요청 오류',404);
 if(req.method==='GET')return reply(200,id?get(k,id)||fail('항목 없음',404):all(k));
 db.exec('BEGIN IMMEDIATE');try{if(req.method==='DELETE'){let r=get(k,id);if(!r)fail('항목 없음',404);if(k==='students')terminate(r);else if(k==='products'&&all('enrollments').some(e=>e.product===r.id)){r.status='종료';save(k,r,id)}else if(k==='enrollments'||k==='lessons'){r.status='무효';r.published=false;save(k,r,id);if(k==='lessons')operations.linkLesson(r)}else db.prepare('DELETE FROM records WHERE id=?').run(Number(id));event(a.id,'삭제/종료 '+k,Number(id));db.exec('COMMIT');return reply(200,{ok:true})}
 if((typeof b.operation_id!=='string'||!b.operation_id||b.operation_id.length>100)&&!id)fail('저장 작업번호가 필요합니다');if(b.operation_id!==undefined&&(typeof b.operation_id!=='string'||!b.operation_id||b.operation_id.length>100))fail('저장 작업번호 오류');const fingerprint=digest(JSON.stringify({target:id||null,data:Object.fromEntries(Object.entries(b).filter(([key])=>key!=='operation_id').sort(([a],[b])=>a.localeCompare(b)))}));let op=b.operation_id&&db.prepare('SELECT result FROM operations WHERE key=?').get(k+':'+b.operation_id);if(op){const cached=JSON.parse(op.result);if(cached.fingerprint&&cached.fingerprint!==fingerprint)fail('같은 작업번호의 입력이 다릅니다',409);const current=get(k,cached.id);if(!current)fail('재시도 대상이 파기되었습니다',410);db.exec('COMMIT');return reply(200,current)}let key=b.operation_id;delete b.operation_id;
 if(k==='students'&&!id){let n=db.prepare('SELECT value FROM counters WHERE id=1').get().value+1;if(n>999999)fail('등록번호 발급 한도');db.prepare('UPDATE counters SET value=? WHERE id=1').run(n);b.number='MBR-'+String(n).padStart(6,'0');db.prepare('INSERT INTO number_history VALUES(?)').run(b.number)}
 if(k==='ledgers'){if(!b.reviewed||!['교습소','개인과외교습자'].includes(b.division)||!validDate(b.basis_date)||!b.number||!b.name)fail('합성 검수 정책과 필수 항목을 확인해 주세요');b.policy='합성 검수용 v1 / 실제 운영 미검수';b.basis=b.division==='교습소'?'교습소 법정 대장: 항목·기산 기준 미검수':'개인과외 운영 대장: 처리 근거 미검수';b.retain_until=id?get(k,id).retain_until:months(b.basis_date+'T00:00:00+09:00',36);b={number:b.number,name:b.name,division:b.division,basis_date:b.basis_date,retain_until:b.retain_until,basis:b.basis,policy:b.policy,reviewed:true,version:b.version}}
 else validate(k,b,id);if(k==='enrollments'&&b.status==='종료'&&(!id||get(k,id).status!=='종료'))b.ended_at=nowISO();let r=save(k,b,id);if(k==='students'&&r.status!=='종료'&&r.delete_due){r.delete_due=null;r.ended_at=null;save(k,r,r.id);r=get(k,r.id)}if(k==='students'&&r.status==='종료'&&!r.delete_due){terminate(r);r=get(k,r.id)}if(k==='enrollments'){reconcile(r.student);r=get(k,r.id)}if(k==='lessons')operations.linkLesson(r);event(a.id,(id?'수정 ':'생성 ')+k,r.id);if(key)db.prepare('INSERT INTO operations VALUES(?,?)').run(k+':'+key,JSON.stringify({id:r.id,fingerprint}));db.exec('COMMIT');reply(200,r)}catch(e){db.exec('ROLLBACK');throw e}
 }catch(e){reply(e.status||500,{error:e.status?e.message:'처리 중 오류가 발생했습니다'})}});
export const runtime=createServiceRuntime({server,db,workers:{alerts:{interval:10000,run:()=>operations.runAlerts()},retention:{interval:60000,run:()=>sweep()}},now:nowMs,grace:runtimeConfig().grace,log:message=>console.error('서비스 실행 상태: '+message)});
if(process.env.NODE_ENV!=='test'){
 if(process.env.APP_MODE==='production'){
  const origin=new URL(process.env.PUBLIC_ORIGIN||'http://invalid');if(origin.protocol!=='https:'||origin.origin!==process.env.PUBLIC_ORIGIN)throw Error('production requires an exact HTTPS PUBLIC_ORIGIN');
  if(db.prepare("SELECT 1 FROM accounts WHERE id='director-demo'").get()||!db.prepare('SELECT 1 FROM accounts WHERE student IS NULL AND enabled=1').get())throw Error('production director setup required; demo account prohibited');
  if(db.prepare('SELECT value FROM metadata WHERE key=?').get('lifecycle')?.value!=='operating')throw Error('reviewed transition to operating required');
  if(db.prepare('SELECT value FROM metadata WHERE key=?').get('restore_state')?.value==='pending')throw Error('restore validation required');
  if(!inspectIntegrity().ok)throw Error('data integrity check failed');
 }
 const config=runtimeConfig();server.listen(config.port,config.host,()=>{runtime.start();console.log('피아노를 담다: 서버 시작 완료')});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{runtime.shutdown().then(({forced})=>{process.exitCode=forced?1:0},()=>{console.error('서비스 정상 종료 실패: 운영 점검 필요');process.exitCode=1})});
}


