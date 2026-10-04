import {randomUUID,createHash} from 'node:crypto';
import {createMockSmsProvider} from './sms-provider.mjs';

const sha = value => createHash('sha256').update(String(value)).digest('hex');
const DAY = 86400000;
const dateOK = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
const timeOK = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const stamp = (d,t) => Date.parse(d+'T'+t+':00+09:00');
const kstDate = n => new Date(n+9*3600000).toISOString().slice(0,10);
const kstTime = n => new Date(n+9*3600000).toISOString().slice(11,16);
const phone = value => String(value||'').replace(/[ -]/g,'');
const phoneOK = value => /^0\d{8,10}$/.test(phone(value));
const mask = value => value ? phone(value).slice(0,3)+'-****-'+phone(value).slice(-4) : '미등록';
const kinds = ['상담','체험','수업','휴무'];
const basePolicy = {version:1,enabled:false,minutes_before:1440,kinds:['수업'],template:'[피아노를 담다] {이름}님, {날짜} {시간} 수업이 예정되어 있습니다.',daily_limit:30,visitor_retention_days:null,retention_confirmed:false};

// All writes use the caller's SQLite transaction. Sending is a separate outbox operation.
export function createOperations({db,all,get,atomic,fail,event,nowMs,checkpoint}) {
 let mockOutcome='전달 성공';
 db.exec(`CREATE TABLE IF NOT EXISTS op_visitors(id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS op_series(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS op_calendar(id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,series TEXT,occurrence TEXT,UNIQUE(series,occurrence));
 CREATE TABLE IF NOT EXISTS op_history(id INTEGER PRIMARY KEY,event_id TEXT NOT NULL REFERENCES op_calendar(id) ON DELETE CASCADE,at TEXT,actor TEXT,before_data TEXT,after_data TEXT,reason TEXT);
 CREATE TABLE IF NOT EXISTS op_alerts(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES op_calendar(id) ON DELETE CASCADE,recipient TEXT NOT NULL,version INTEGER NOT NULL,policy_version INTEGER NOT NULL,contact_hash TEXT,due INTEGER,status TEXT,reason TEXT,lease_until INTEGER,provider_id TEXT,UNIQUE(event_id,recipient));
 CREATE TABLE IF NOT EXISTS op_attempts(id INTEGER PRIMARY KEY,job TEXT NOT NULL REFERENCES op_alerts(id) ON DELETE CASCADE,at TEXT,outcome TEXT);
 CREATE TABLE IF NOT EXISTS op_mock_receipts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS op_mutations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS op_settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO op_settings VALUES(1,?)').run(JSON.stringify(basePolicy));
 const receiptColumns=new Set(db.prepare('PRAGMA table_info(op_mock_receipts)').all().map(c=>c.name));if(!receiptColumns.has('at'))db.exec('ALTER TABLE op_mock_receipts ADD COLUMN at INTEGER NOT NULL DEFAULT 0');
 const attemptColumns=new Set(db.prepare('PRAGMA table_info(op_attempts)').all().map(c=>c.name));if(!attemptColumns.has('provider_id'))db.exec('ALTER TABLE op_attempts ADD COLUMN provider_id TEXT');
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS op_attempt_receipt ON op_attempts(provider_id)');
 const provider=createMockSmsProvider({db,nowMs});
 db.exec(`CREATE TRIGGER IF NOT EXISTS op_calendar_insert BEFORE INSERT ON op_calendar BEGIN
 SELECT CASE WHEN json_extract(NEW.data,'$.student') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE kind='students' AND id=json_extract(NEW.data,'$.student')) THEN RAISE(ABORT,'invalid calendar student') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.visitor') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM op_visitors WHERE id=json_extract(NEW.data,'$.visitor')) THEN RAISE(ABORT,'invalid calendar visitor') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.enrollment') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE kind='enrollments' AND id=json_extract(NEW.data,'$.enrollment') AND json_extract(data,'$.student')=json_extract(NEW.data,'$.student')) THEN RAISE(ABORT,'invalid calendar enrollment') END;
 END;
 CREATE TRIGGER IF NOT EXISTS op_calendar_update BEFORE UPDATE ON op_calendar BEGIN
 SELECT CASE WHEN json_extract(NEW.data,'$.student') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE kind='students' AND id=json_extract(NEW.data,'$.student')) THEN RAISE(ABORT,'invalid calendar student') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.visitor') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM op_visitors WHERE id=json_extract(NEW.data,'$.visitor')) THEN RAISE(ABORT,'invalid calendar visitor') END;
 SELECT CASE WHEN json_extract(NEW.data,'$.enrollment') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM records WHERE kind='enrollments' AND id=json_extract(NEW.data,'$.enrollment') AND json_extract(data,'$.student')=json_extract(NEW.data,'$.student')) THEN RAISE(ABORT,'invalid calendar enrollment') END;
 END;
 CREATE TRIGGER IF NOT EXISTS op_record_delete BEFORE DELETE ON records BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM op_calendar WHERE json_extract(data,'$.student')=OLD.id OR json_extract(data,'$.enrollment')=OLD.id OR json_extract(data,'$.lesson_id')=OLD.id) THEN RAISE(ABORT,'record has calendar references') END;
 END;
 CREATE TRIGGER IF NOT EXISTS op_visitor_delete BEFORE DELETE ON op_visitors BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM op_calendar WHERE json_extract(data,'$.visitor')=OLD.id) THEN RAISE(ABORT,'visitor has calendar references') END;
 END;`);
 const policy=()=>JSON.parse(db.prepare('SELECT data FROM op_settings WHERE id=1').get().data);
 const calendar=()=>db.prepare('SELECT * FROM op_calendar ORDER BY json_extract(data,\'$.date\'),json_extract(data,\'$.time\')').all().map(r=>({...JSON.parse(r.data),id:r.id,version:r.version,series:r.series,occurrence:r.occurrence}));
 const visitors=()=>db.prepare('SELECT * FROM op_visitors').all().map(r=>({...JSON.parse(r.data),id:r.id,version:r.version}));
 const find=id=>calendar().find(e=>e.id===id)||fail('일정을 찾을 수 없습니다',404);
 const visitor=id=>visitors().find(v=>v.id===Number(id));
 const alerts=()=>db.prepare('SELECT * FROM op_alerts ORDER BY due').all();
 function only(body,keys){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))fail('허용되지 않은 입력 항목')}
 function integer(v,min,max,label){if(!Number.isSafeInteger(v)||v<min||v>max)fail(label+' 값을 확인해 주세요')}
 function mutation(body,prefix,fn){if(typeof body.operation_id!=='string'||!body.operation_id||body.operation_id.length>100)fail('작업번호가 필요합니다');const key=prefix+':'+body.operation_id,fp=sha(JSON.stringify(body));return atomic(()=>{const old=db.prepare('SELECT * FROM op_mutations WHERE key=?').get(key);if(old){if(old.fingerprint!==fp)fail('같은 작업번호의 입력이 다릅니다',409);return JSON.parse(old.result)}const result=fn();checkpoint('operations-after-save');db.prepare('INSERT INTO op_mutations VALUES(?,?,?)').run(key,fp,JSON.stringify(result));return result})}
 function target(e){return e.student?get('students',e.student):visitor(e.visitor)}
 function recipient(e){const t=target(e);const value=e.recipient==='보호자'?t?.guardian_contact:t?.contact;return {name:t?.name||'대상 없음',value:phone(value),hash:sha(phone(value))}}
 function textFor(e,p=policy()){const r=recipient(e);return p.template.replace(/\{(이름|날짜|시간|종류)\}/g,(_,k)=>({이름:r.name,날짜:e.date,시간:e.time,종류:e.kind}[k]))}
 function eligible(e){if(e.status!=='확정')return '일정 미확정/취소';if(e.result)return '진행 결과 기록됨';if(e.kind==='수업'){const s=get('students',e.student),n=get('enrollments',e.enrollment);if(!s||s.status!=='재원'||!n||n.student!==s.id||n.status!=='유효'||e.date<n.start||(n.end&&e.date>n.end))return '수강 상태/기간 확인 필요'}return ''}
 function validate(d,id,exclude=[]){
  if(!kinds.includes(d.kind)||!['임시','확정','취소'].includes(d.status)||!dateOK(d.date)||!timeOK(d.time))fail('종류·날짜·시간·상태를 확인해 주세요');integer(d.duration,5,720,'소요시간');
  if(!['','완료','미방문'].includes(d.result||''))fail('진행 결과 오류');if(typeof d.reminder!=='boolean'||typeof d.recipient_confirmed!=='boolean')fail('알림 확인 값을 확인해 주세요');
  for(const k of ['reason','room'])if(typeof d[k]!=='string'||d[k].length>200)fail('변경 사유·공간은 200자 이내입니다');
  if(!['본인','보호자'].includes(d.recipient))fail('수신자를 선택해 주세요');
  if(d.student!==null&&!Number.isSafeInteger(d.student)||d.visitor!==null&&!Number.isSafeInteger(d.visitor)||d.enrollment!==null&&!Number.isSafeInteger(d.enrollment))fail('연결 대상 오류');
  if(d.kind==='휴무'){if(d.student||d.visitor||d.enrollment||d.reminder)fail('휴무에는 수신 대상과 알림을 지정할 수 없습니다')}
  else {if(Boolean(d.student)===Boolean(d.visitor)||!target(d))fail('학생 또는 방문자 한 명을 선택해 주세요');if(d.kind==='수업'){const n=get('enrollments',d.enrollment);if(!d.student||!n||n.student!==d.student)fail('학생의 수강등록을 선택해 주세요');if(d.status==='확정'&&eligible({...d,result:''}))fail('수강 상태·기간을 확인해 주세요')}else if(d.enrollment!==null)fail('상담·체험에는 수강 연결을 입력하지 마세요')}
  if(d.reminder&&d.status==='확정'&&(d.result||!d.recipient_confirmed||!phoneOK(recipient(d).value)))fail('알림 대상 번호를 확인하거나 알림을 꺼 주세요');
  const start=stamp(d.date,d.time),end=start+d.duration*60000;
  if(d.status!=='취소'&&calendar().some(e=>e.id!==id&&!exclude.includes(e.id)&&e.status!=='취소'&&start<stamp(e.date,e.time)+e.duration*60000&&stamp(e.date,e.time)<end))fail('원장 일정 또는 휴무 시간이 겹칩니다',409);
 }
 function details(e){return {...e,name:target(e)?.name||'학원 휴무',masked_contact:e.kind==='휴무'?'':mask(recipient(e).value),eligibility:eligible(e)}}
 function preview(body){const d=normalize(body);validate(d,body.id);const p=policy(),r=recipient(d),due=stamp(d.date,d.time)-p.minutes_before*60000;const shared=r.value?all('students').filter(s=>s.id!==d.student&&(phone(s.contact)===r.value||phone(s.guardian_contact)===r.value)).length+visitors().filter(v=>v.id!==d.visitor&&(phone(v.contact)===r.value||phone(v.guardian_contact)===r.value)).length:0;return {event:d,name:r.name,masked_contact:mask(r.value),phone_valid:phoneOK(r.value),shared_targets:shared,text:d.kind==='휴무'?'':textFor(d),due:new Date(due).toISOString(),mode:'mock',cost:null,policy_enabled:p.enabled,policy_kind:p.kinds.includes(d.kind),late:due<=nowMs(),notice:'모의 발송 전용 · 실제 비용 미확정'}}
 function normalize(b){for(const k of ['reminder','recipient_confirmed'])if(b[k]!==undefined&&typeof b[k]!=='boolean')fail('알림 확인 값은 참/거짓이어야 합니다');return {kind:b.kind,status:b.status,date:b.date,time:b.time,duration:b.duration,student:b.student??null,visitor:b.visitor??null,enrollment:b.enrollment??null,type:b.type||'정규',room:b.room||'',reason:b.reason||'',result:b.result||'',recipient:b.recipient||'본인',reminder:b.reminder===true,recipient_confirmed:b.recipient_confirmed===true}}
 const inputKeys=['id','version','operation_id','kind','status','date','time','duration','student','visitor','enrollment','type','room','reason','result','recipient','reminder','recipient_confirmed','scope'];
 function sync(e){
  const p=policy(),old=db.prepare('SELECT * FROM op_alerts WHERE event_id=?').all(e.id),due=stamp(e.date,e.time)-p.minutes_before*60000;
  for(const j of old){if(['업체 접수','전달 성공','결과 확인 중','처리 중'].includes(j.status))continue;db.prepare('UPDATE op_alerts SET status=?,reason=? WHERE id=?').run('발송 전 취소','일정/대상 갱신',j.id)}
  if(!e.reminder||e.status!=='확정'||e.kind==='휴무')return;
  const r=recipient(e),existing=old.find(j=>j.recipient===e.recipient);
  if(old.some(j=>['업체 접수','전달 성공','처리 중','결과 확인 중'].includes(j.status)))return;
  const failed=existing?.status==='전달 실패';
  let reason=eligible(e)||(!p.enabled?'자동 알림 중단':!p.kinds.includes(e.kind)?'종류별 알림 비활성':!e.recipient_confirmed||e.confirmed_hash!==r.hash?'수신자 확인 필요':e.confirmed_policy!==p.version?'알림 설정 변경 · 일정 재확인 필요':!phoneOK(r.value)?'연락처 확인 필요':due<=nowMs()&&(!failed||nowMs()-due>5*60000)?'알림 시각이 이미 지남':'');
  const values=[e.version,p.version,r.hash,due,reason?'보류':failed?'전달 실패':'발송 대기',reason||(failed?'실패 확인 후 재시도 필요':''),e.id,e.recipient];
  if(existing)db.prepare('UPDATE op_alerts SET version=?,policy_version=?,contact_hash=?,due=?,status=?,reason=?,lease_until=NULL WHERE event_id=? AND recipient=?').run(...values);
  else db.prepare('INSERT INTO op_alerts(id,version,policy_version,contact_hash,due,status,reason,event_id,recipient) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),...values);
 }
 function persist(d,old,actor,series=null,occurrence=null){
  const id=old?.id||randomUUID(),version=(old?.version||0)+1,r=recipient(d);
  const data={...d,confirmed_hash:d.recipient_confirmed?r.hash:null,confirmed_policy:policy().version,lesson_id:old?.lesson_id||null};
  if(old&&(old.date!==d.date||old.time!==d.time||old.student!==d.student||old.enrollment!==d.enrollment))data.lesson_id=null;
  if(old)db.prepare('UPDATE op_calendar SET data=?,version=? WHERE id=?').run(JSON.stringify(data),version,id);
  else db.prepare('INSERT INTO op_calendar VALUES(?,?,?,?,?)').run(id,JSON.stringify(data),version,series,occurrence);
  const safe=e=>e?JSON.stringify({kind:e.kind,date:e.date,time:e.time,duration:e.duration,status:e.status,result:e.result}):null;
  db.prepare('INSERT INTO op_history(event_id,at,actor,before_data,after_data,reason) VALUES(?,?,?,?,?,?)').run(id,new Date(nowMs()).toISOString(),actor,safe(old),safe(data),d.reason);
  const e=find(id);sync(e);event(actor,'운영 일정 '+(old?'변경':'등록'),null);return e;
 }
 function saveCalendar(b,actor){only(b,inputKeys);return mutation(b,'calendar',()=>{
  const old=b.id?find(b.id):null;if(old&&b.version!==old.version)fail('다른 화면에서 일정이 변경되었습니다',409);const d=normalize(b);if(old&&!d.reason.trim())fail('변경 사유를 입력해 주세요');
  if(!['정규','보강'].includes(d.type))fail('수업 종류 오류');
  if(old&&b.scope==='future'&&old.series){
   if(d.kind!==old.kind||d.student!==old.student||d.visitor!==old.visitor||d.enrollment!==old.enrollment)fail('대상 변경은 개별 회차로 처리해 주세요');
   const selected=calendar().filter(e=>e.series===old.series&&e.occurrence>=old.occurrence&&e.status!=='취소'),exclude=selected.map(e=>e.id),delta=stamp(d.date,d.time)-stamp(old.date,old.time);
   const changed=selected.map(e=>{const at=stamp(e.date,e.time)+delta;return {old:e,data:{...d,date:kstDate(at),time:kstTime(at)}}});
   for(const c of changed)validate(c.data,c.old.id,exclude);
   for(let i=0;i<changed.length;i++)for(let j=i+1;j<changed.length;j++){const x=changed[i].data,y=changed[j].data;if(x.status!=='취소'&&y.status!=='취소'&&stamp(x.date,x.time)<stamp(y.date,y.time)+y.duration*60000&&stamp(y.date,y.time)<stamp(x.date,x.time)+x.duration*60000)fail('변경할 회차끼리 시간이 겹칩니다',409)}
   return {items:changed.map(c=>details(persist(c.data,c.old,actor)))};
  }
  if(b.scope&&b.scope!=='single')fail('변경 범위를 확인해 주세요');validate(d,old?.id);return details(persist(d,old,actor));
 })}
 function saveVisitor(b,actor){only(b,['id','version','operation_id','name','contact','guardian_contact','relation','contact_confirmed']);return mutation(b,'visitor',()=>{if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!['본인','보호자'].includes(b.relation)||typeof b.contact_confirmed!=='boolean')fail('방문자 이름·관계·번호 확인을 입력해 주세요');for(const k of ['contact','guardian_contact'])if(typeof b[k]!=='string'||b[k].length>30||b[k]&&!phoneOK(b[k]))fail('연락처 형식을 확인해 주세요');if(b.contact_confirmed&&!phoneOK(b.relation==='보호자'?b.guardian_contact:b.contact))fail('확인할 수신 번호가 없습니다');const old=b.id?visitor(b.id):null;if(b.id&&!old)fail('방문자 없음',404);if(old&&b.version!==old.version)fail('방문자 버전 충돌',409);const data={name:b.name.trim(),contact:phone(b.contact),guardian_contact:phone(b.guardian_contact),relation:b.relation,contact_confirmed:b.contact_confirmed,created_at:old?.created_at||new Date(nowMs()).toISOString()};let id;if(old){id=old.id;db.prepare('UPDATE op_visitors SET data=?,version=version+1 WHERE id=?').run(JSON.stringify(data),id)}else id=Number(db.prepare('INSERT INTO op_visitors(data) VALUES(?)').run(JSON.stringify(data)).lastInsertRowid);event(actor,'상담·체험 방문자 저장',null);return visitor(id)})}
 function savePolicy(b,actor){only(b,['version','operation_id','enabled','minutes_before','kinds','template','daily_limit','visitor_retention_days','retention_confirmed']);return mutation(b,'policy',()=>{const old=policy();if(old.version!==b.version)fail('알림 설정 버전 충돌',409);if(typeof b.enabled!=='boolean'||typeof b.retention_confirmed!=='boolean'||!Array.isArray(b.kinds)||b.kinds.some(k=>!['수업','상담','체험'].includes(k))||new Set(b.kinds).size!==b.kinds.length)fail('알림 종류·활성화 오류');integer(b.minutes_before,1,10080,'알림 시점');integer(b.daily_limit,1,1000,'일일 모의 접수 상한');if(typeof b.template!=='string'||!b.template.trim()||b.template.length>500||/\{(?!(이름|날짜|시간|종류)\})[^}]*\}/.test(b.template)||!b.template.includes('{날짜}')||!b.template.includes('{시간}'))fail('템플릿은 날짜·시간을 포함하며 허용 항목만 사용하세요');if(b.kinds.some(k=>k!=='수업')&&!b.template.includes('{종류}'))fail('상담·체험 알림에는 {종류}를 포함한 공통 문구를 사용하세요');if(b.visitor_retention_days!==null)integer(b.visitor_retention_days,1,3650,'방문자 보관 기간');if(b.retention_confirmed&&b.visitor_retention_days===null)fail('보관 기간을 입력해 주세요');const {operation_id,...p}=b;p.version=old.version+1;db.prepare('UPDATE op_settings SET data=? WHERE id=1').run(JSON.stringify(p));for(const e of calendar())sync(e);event(actor,'자동 알림 설정 변경',null);return p})}
 function checkJob(j,e,p,at){const r=recipient(e);return eligible(e)||(!e.reminder?'일정 알림 꺼짐':!p.enabled?'자동 알림 중단':!p.kinds.includes(e.kind)?'종류별 알림 비활성':j.version!==e.version?'일정 버전 변경':j.policy_version!==p.version||e.confirmed_policy!==p.version?'알림 설정 변경':!e.recipient_confirmed||e.confirmed_hash!==r.hash||j.contact_hash!==r.hash?'수신자 변경/미확인':!phoneOK(r.value)?'연락처 확인 필요':e.visitor&&(!visitor(e.visitor)?.contact_confirmed||visitor(e.visitor)?.relation!==e.recipient)?'방문자 수신 번호 미확인':stamp(e.date,e.time)<=at?'수업 시작 시각 지남':at-j.due>5*60000?'알림 시각이 이미 지남':'')}
 function reconcile(){return atomic(()=>{let count=0;for(const j of alerts().filter(j=>j.status==='결과 확인 중'||j.status==='처리 중'&&j.lease_until<=nowMs())){const receipt=j.provider_id&&db.prepare('SELECT status,at FROM op_mock_receipts WHERE id=?').get(j.provider_id);db.prepare('UPDATE op_alerts SET status=?,reason=?,lease_until=NULL WHERE id=?').run(receipt?.status||'결과 확인 중',receipt?'모의 접수 결과 조회 완료':'응답 유실 · 접수 결과 확인 필요',j.id);if(receipt){db.prepare('INSERT OR IGNORE INTO op_attempts(job,at,outcome,provider_id) VALUES(?,?,?,?)').run(j.id,new Date(receipt.at+9*3600000).toISOString(),receipt.status,j.provider_id);count++}}return {resolved:count}})}
 function runAlerts(){reconcile();let sent=0,held=0;for(let count=0;count<100;count++){
  const claimed=atomic(()=>{const j=db.prepare("SELECT * FROM op_alerts WHERE status='발송 대기' AND due<=? ORDER BY due LIMIT 1").get(nowMs());if(!j)return null;const e=find(j.event_id),p=policy();let reason=checkJob(j,e,p,nowMs());const dayStart=stamp(kstDate(nowMs()),'00:00'),used=db.prepare('SELECT count(*) n FROM op_mock_receipts WHERE at>=? AND at<?').get(dayStart,dayStart+DAY).n;
   if(process.env.APP_MODE==='production')reason='실제 문자 업체 연결 미설정';if(used>=p.daily_limit)reason='일일 모의 접수 상한';
   if(reason){db.prepare('UPDATE op_alerts SET status=?,reason=? WHERE id=?').run('보류',reason,j.id);held++;return {held:true}}
   const pid=j.provider_id||'mock-'+j.id;db.prepare('UPDATE op_alerts SET status=?,lease_until=?,provider_id=? WHERE id=?').run('처리 중',nowMs()+60000,pid,j.id);return {...j,provider_id:pid};
  });if(!claimed)break;if(claimed.held)continue;
  try{checkpoint('alert-after-claim');const receipt=atomic(()=>{const fresh=find(claimed.event_id),p=policy(),start=stamp(kstDate(nowMs()),'00:00'),used=db.prepare('SELECT count(*) n FROM op_mock_receipts WHERE at>=? AND at<?').get(start,start+DAY).n;const reason=checkJob(claimed,fresh,p,nowMs())||(used>=p.daily_limit?'일일 모의 접수 상한':'');if(reason){db.prepare('UPDATE op_alerts SET status=?,reason=?,lease_until=NULL WHERE id=?').run('보류',reason,claimed.id);return null}return provider.send({key:claimed.provider_id,to:recipient(fresh).value,text:textFor(fresh),outcome:mockOutcome})});if(!receipt){held++;continue}checkpoint('alert-after-provider');
   const outcome=receipt.status;
   atomic(()=>{db.prepare('UPDATE op_alerts SET status=?,reason=?,lease_until=NULL WHERE id=?').run(outcome,'모의 발송 · 외부 호출 없음',claimed.id);db.prepare('INSERT OR IGNORE INTO op_attempts(job,at,outcome,provider_id) VALUES(?,?,?,?)').run(claimed.id,new Date(nowMs()+9*3600000).toISOString(),outcome,claimed.provider_id)});if(outcome==='전달 성공')sent++;
  }catch{db.prepare('UPDATE op_alerts SET status=?,reason=? WHERE id=?').run('결과 확인 중','접수 결과 조회 필요',claimed.id)}
 }return {mode:'mock',sent,held,external_calls:0}}
 function review(id,b){return atomic(()=>{const j=db.prepare('SELECT * FROM op_alerts WHERE id=?').get(id);if(!j)fail('알림 없음',404);if(j.status!=='전달 실패')fail('실패가 확인된 알림만 재시도할 수 있습니다',409);if(b.version!==j.version)fail('알림 버전 충돌',409);const e=find(j.event_id);if(checkJob(j,e,policy(),nowMs()))fail('대상/시각을 다시 확인해 주세요');const pid='mock-'+j.id+'-'+randomUUID();db.prepare('UPDATE op_alerts SET status=?,reason=?,provider_id=? WHERE id=?').run('발송 대기','실패 확인 후 재시도',pid,id);return {ok:true}})}
 function repeatPreview(b){only(b,[...inputKeys,'until','skip_dates']);if(!dateOK(b.until)||!dateOK(b.date)||b.until<b.date||Date.parse(b.until)-Date.parse(b.date)>364*DAY)fail('반복 종료일은 시작일부터 1년 이내입니다');const skip=b.skip_dates||[];if(!Array.isArray(skip)||skip.some(d=>!dateOK(d)||d<b.date||d>b.until||(Date.parse(d)-Date.parse(b.date))%(7*DAY)!==0)||new Set(skip).size!==skip.length)fail('제외 날짜는 반복 회차의 날짜여야 합니다');const d=normalize(b),items=[];for(let at=stamp(d.date,d.time);kstDate(at)<=b.until;at+=7*DAY){const next={...d,date:kstDate(at)},skipped=skip.includes(next.date);let error='';if(!skipped)try{validate(next)}catch(e){error=e.message}items.push({event:next,error,skipped})}return {items,ok:items.some(i=>!i.skipped)&&items.every(i=>!i.error)}}
 function repeatSave(b,actor){return mutation(b,'repeat',()=>{const p=repeatPreview(b);if(!p.ok)fail('반복 후보의 충돌을 해결해 주세요',409);const series=randomUUID();db.prepare('INSERT INTO op_series VALUES(?,?)').run(series,JSON.stringify({until:b.until,skip_dates:b.skip_dates||[]}));const items=p.items.filter(i=>!i.skipped).map(({event:d})=>details(persist(d,null,actor,series,d.date)));return {series,items}})}
 function linkVisitor(id,b,actor){only(b,['version','student','verified','operation_id']);return mutation({...b,target:Number(id)},'visitor-link',()=>{const v=visitor(id),s=get('students',b.student);if(!v||!s)fail('방문자와 등록 학생을 확인해 주세요');if(v.version!==b.version)fail('방문자 버전 충돌',409);if(b.verified!==true||s.status==='종료')fail('대상 동일인 확인과 학생 상태를 확인해 주세요');const es=calendar().filter(e=>e.visitor===v.id);for(const old of es){const data=normalize({...old,student:s.id,visitor:null,recipient_confirmed:false,reminder:false,reason:'원장 확인 후 등록 학생 연결'});persist(data,old,actor)}db.prepare('UPDATE op_visitors SET version=version+1 WHERE id=?').run(v.id);return {linked:es.length,student:s.id,notice:'학생 계정과 연락처는 변경하지 않았습니다. 알림은 일정에서 재확인하세요.'}})}
 function purgeStudent(id){const ids=calendar().filter(e=>e.student===id).map(e=>e.id);for(const eid of ids)removeEvent(eid);db.exec('DELETE FROM op_mutations');cleanSeries()}
 function removeEvent(id){for(const j of db.prepare('SELECT id,provider_id FROM op_alerts WHERE event_id=?').all(id)){for(const a of db.prepare('SELECT provider_id FROM op_attempts WHERE job=?').all(j.id))if(a.provider_id)db.prepare('DELETE FROM op_mock_receipts WHERE id=?').run(a.provider_id);if(j.provider_id)db.prepare('DELETE FROM op_mock_receipts WHERE id=?').run(j.provider_id)}db.prepare('DELETE FROM op_calendar WHERE id=?').run(id)}
 function cleanSeries(){db.exec('DELETE FROM op_series WHERE id NOT IN (SELECT series FROM op_calendar WHERE series IS NOT NULL)')}
 function purgeVisitor(id){for(const e of calendar().filter(e=>e.visitor===id))removeEvent(e.id);db.prepare('DELETE FROM op_visitors WHERE id=?').run(id);db.exec('DELETE FROM op_mutations');cleanSeries()}
 function sweepVisitors(at){const p=policy();if(!p.retention_confirmed||!p.visitor_retention_days)return;for(const v of visitors()){const es=calendar().filter(e=>e.visitor===v.id),last=Math.max(Date.parse(v.created_at),...es.map(e=>stamp(e.date,e.time)+e.duration*60000));if(last+p.visitor_retention_days*DAY>Date.parse(at))continue;purgeVisitor(v.id);db.prepare('INSERT OR IGNORE INTO deletion_journal.entries SELECT value,?,?,? FROM metadata WHERE key=?').run('visitors',v.id,at,'dataset')}}
 function linkLesson(l){for(const e of calendar()){if(e.lesson_id===l.id||e.kind==='수업'&&e.status==='확정'&&e.student===l.student&&e.enrollment===l.enrollment&&e.date===l.date&&e.time===l.time){const link=e.kind==='수업'&&e.status==='확정'&&e.student===l.student&&e.enrollment===l.enrollment&&e.date===l.date&&e.time===l.time&&l.status!=='무효'?l.id:null;const {id,version,series,occurrence,...data}=e;data.lesson_id=link;db.prepare('UPDATE op_calendar SET data=? WHERE id=?').run(JSON.stringify(data),id)}}}
 function dashboard(date){if(!dateOK(date))fail('조회 날짜 오류');const es=calendar(),today=es.filter(e=>e.date===date&&e.status==='확정'),js=alerts(),end=new Date(Date.parse(date)+14*DAY).toISOString().slice(0,10);const tasks=[...js.filter(j=>['보류','전달 실패','결과 확인 중'].includes(j.status)).map(j=>({kind:'알림 확인',label:j.reason,id:j.event_id,job:j.id})),...js.filter(j=>['전달 성공','업체 접수'].includes(j.status)&&find(j.event_id).version!==j.version).map(j=>({kind:'변경 후 안내 검토',label:'이미 안내한 일정이 변경되었습니다. 후속 안내를 확인하세요.',id:j.event_id})),...es.filter(e=>e.kind==='수업'&&e.status==='확정'&&eligible(e)).map(e=>({kind:'일정 검토',label:eligible(e),id:e.id})),...all('lessons').filter(l=>l.status==='완료'&&!l.published).map(l=>({kind:'미공개 수업',label:l.date,record:l.id,tab:'lessons'})),...all('enrollments').filter(e=>e.status==='유효'&&e.end&&e.end>=date&&e.end<=end).map(e=>({kind:'종료 예정',label:e.end,record:e.id,tab:'enrollments'}))];const from=new Date(stamp(date,'00:00')-7*DAY).toISOString(),to=new Date(stamp(date,'00:00')+DAY).toISOString();return {date,updated_at:new Date(nowMs()).toISOString(),counts:Object.fromEntries(kinds.map(k=>[k,today.filter(e=>e.kind===k).length])),items:today.map(details),tasks,changes:db.prepare('SELECT * FROM op_history WHERE at>=? AND at<? ORDER BY id DESC LIMIT 20').all(from,to).map(h=>({...h,event:details(find(h.event_id))})),alerts:{pending:js.filter(j=>j.status==='발송 대기').length,held:js.filter(j=>j.status==='보류').length,failed:js.filter(j=>j.status==='전달 실패').length,unknown:js.filter(j=>j.status==='결과 확인 중').length,next:js.find(j=>j.status==='발송 대기')?.due||null},registered:es.length,policy:policy(),mode:'mock'}}
 function integrity(){const errors=[];for(const e of calendar()){if(e.student&&!get('students',e.student)||e.visitor&&!visitor(e.visitor)||e.enrollment&&!get('enrollments',e.enrollment)||e.lesson_id&&!get('lessons',e.lesson_id))errors.push('calendar-reference:'+e.id)}return errors}
 function refreshEligibility(){for(const j of alerts().filter(j=>j.status==='발송 대기')){const e=find(j.event_id),r=recipient(e),reason=eligible(e)||(e.confirmed_hash!==r.hash?'수신자 변경/미확인':'');if(reason)db.prepare('UPDATE op_alerts SET status=?,reason=? WHERE id=?').run('보류',reason,j.id)}}
 function restored(){db.prepare("UPDATE op_alerts SET status='보류',reason='복원 후 알림 재검토 필요',lease_until=NULL WHERE status IN ('발송 대기','처리 중')").run();const p=policy();p.enabled=false;db.prepare('UPDATE op_settings SET data=? WHERE id=1').run(JSON.stringify(p));db.exec('DELETE FROM op_mutations')}
 function route(k,id,method,b,url,actor){
  if(k==='dashboard'){if(method!=='GET')fail('GET 요청이 필요합니다',405);return dashboard(url.searchParams.get('date')||kstDate(nowMs()))}
  if(k==='calendar'){if(method==='GET'){const es=calendar();if(id)return {event:details(find(id)),history:db.prepare('SELECT * FROM op_history WHERE event_id=? ORDER BY id DESC').all(id),alerts:alertList().filter(j=>j.event_id===id)};const from=url.searchParams.get('from')||kstDate(nowMs()),to=url.searchParams.get('to')||from;if(!dateOK(from)||!dateOK(to)||from>to||Date.parse(to)-Date.parse(from)>366*DAY)fail('조회 기간 오류');return es.filter(e=>e.date>=from&&e.date<=to).map(details)}if(method==='POST'||method==='PUT'){if(method==='PUT'&&!id)fail('일정 ID 필요');if(method==='POST'&&id)fail('요청 오류');return saveCalendar({...b,...(id?{id}: {})},actor)}}
  if(k==='calendar-preview'&&method==='POST'){only(b,inputKeys);return preview(b)}
  if(k==='repeat-preview'&&method==='POST')return repeatPreview(b);
  if(k==='repeat'&&method==='POST')return repeatSave(b,actor);
  if(k==='visitors'){if(method==='GET')return visitors().map(v=>({...v,masked_contact:mask(v.relation==='보호자'?v.guardian_contact:v.contact)}));if(method==='POST'||method==='PUT')return saveVisitor({...b,...(id?{id:Number(id)}:{})},actor)}
  if(k==='visitor-link'&&method==='POST')return linkVisitor(id,b,actor);
  if(k==='alert-policy'){if(method==='GET')return {...policy(),mode:'mock',provider_ready:false};if(method==='PUT')return savePolicy(b,actor)}
  if(k==='alerts'&&method==='GET')return alertList();
  if(k==='alerts-run'&&method==='POST')return runAlerts();
  if(k==='alerts-reconcile'&&method==='POST')return reconcile();
  if(k==='alerts-retry'&&method==='POST')return review(id,b);
  fail('요청한 운영 기능을 찾을 수 없습니다',404);
 }
 function alertList(){return alerts().map(j=>{const e=find(j.event_id),r=recipient(e);return {...j,event:details(e),name:r.name,masked_contact:mask(r.value),text:textFor(e),preview_label:'현재 일정 기준 미리보기',attempts:db.prepare('SELECT at,outcome FROM op_attempts WHERE job=?').all(j.id),mode:'mock'}})}
 return {route,runAlerts,purgeStudent,purgeVisitor,sweepVisitors,linkLesson,integrity,restored,refreshEligibility,calendar,policy,setMockOutcome(value){if(process.env.NODE_ENV!=='test'||!['전달 성공','전달 실패','결과 확인 중'].includes(value))fail('검사 전용 모의 결과입니다');mockOutcome=value}};
}
