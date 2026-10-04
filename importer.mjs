import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number=/^MBR-\d{6}$/;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const reject=(text,status=400)=>{throw Object.assign(Error(text),{status})};
const allowed={students:['source_key','number','name','axis','status','minor','contact','guardian','guardian_contact','song','goal'],products:['source_key','name','axis','duration','status'],enrollments:['source_key','student_key','product_key','start','end','division','schedule','status'],lessons:['source_key','student_key','enrollment_key','date','time','status','type','song','task','next_goal','internal','published']};
export function previewImport(db,input){
 const errors=[],excluded=[],counts={};
 if(!input||typeof input!=='object'||Array.isArray(input))return {ok:false,errors:['자료 형식 오류'],excluded,counts};
 if(typeof input.batch_id!=='string'||!input.batch_id||input.batch_id.length>100)errors.push('배치ID 누락/형식');
 const source=input.source;
 if(!source||typeof source.file!=='string'||!source.file.trim()||!Number.isSafeInteger(source.tab_id)||source.header_row!==4||source.version!=='v1.1')errors.push('원본 파일/탭ID/헤더4행/버전v1.1 검수 필요');
 if(typeof input.cutoff!=='string'||!Number.isFinite(Date.parse(input.cutoff))||!/(Z|[+-]\d{2}:\d{2})$/.test(input.cutoff))errors.push('시간대가 있는 기준시각 필요');
 const sets={};for(const kind of Object.keys(allowed)){let rows=input[kind]??[];if(!Array.isArray(rows)){errors.push(kind+' 배열 오류');rows=[]}if(rows.length>5000)errors.push(kind+' 5000행 한도');sets[kind]=new Map();counts[kind]=0;
  for(const [i,r] of rows.entries()){
   const label=kind+':'+(i+1);if(!r||typeof r!=='object'||Array.isArray(r)){errors.push(label+' 입력 형식');continue}
   if(kind==='lessons'&&Object.keys(r).every(k=>['source_key','id'].includes(k))){excluded.push(label+' ID만 있는 템플릿');continue}
   if(typeof r.source_key!=='string'||!r.source_key||r.source_key.length>100||sets[kind].has(r.source_key))errors.push(label+' 원본키 누락/중복');else sets[kind].set(r.source_key,r);
   if(Object.keys(r).some(k=>!allowed[kind].includes(k)))errors.push(label+' 승인 매핑 외 필드');
   if(Object.entries(r).some(([key,v])=>key==='minor'||key==='published'?typeof v!=='boolean':typeof v!=='string'))errors.push(label+' 필드 자료형 오류');
   if(Object.values(r).some(v=>typeof v==='string'&&v.length>5000))errors.push(label+' 입력 길이 초과');
   if(kind==='students'){if(!number.test(r.number)||typeof r.name!=='string'||!r.name.trim()||!['성인 스튜디오','개인과외'].includes(r.axis)||!['재원','휴원'].includes(r.status)||typeof r.minor!=='boolean')errors.push(label+' 학생 번호/이름/운영축/상태/미성년 값 검수');if(db.prepare("SELECT 1 FROM records WHERE kind='students' AND json_extract(data,'$.number')=?").get(r.number)||db.prepare('SELECT 1 FROM number_history WHERE number=?').get(r.number))errors.push(label+' 기존 번호와 충돌')}
   if(kind==='products'&&(typeof r.name!=='string'||!r.name.trim()||!['성인 스튜디오','개인과외'].includes(r.axis)||!['사용','종료'].includes(r.status)))errors.push(label+' 상품 검수');
   if(kind==='enrollments'){if(!sets.students.has(r.student_key)||!sets.products.has(r.product_key)||!date(r.start)||(r.end&&!date(r.end))||(r.end&&r.end<r.start)||!['교습소','개인과외교습자'].includes(r.division)||!['유효','휴원'].includes(r.status))errors.push(label+' 수강 참조/날짜/관리 구분/상태 검수')}
   if(kind==='lessons'){const e=sets.enrollments.get(r.enrollment_key);if(!sets.students.has(r.student_key)||!e||e.student_key!==r.student_key||!date(r.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)||r.date<e.start||(e.end&&r.date>e.end))errors.push(label+' 수업 참조/기간/시각 검수');if(!['임시','예정','완료','취소','무효'].includes(r.status)||!['정규','보강'].includes(r.type)||r.published!==false)errors.push(label+' 완료 불명확 상태 보류 / 최초 이관 비공개 필수')}
   counts[kind]++;
  }
 }
 const products=[...sets.products.values()];for(let i=0;i<products.length;i++){const p=products[i];if(db.prepare("SELECT 1 FROM records WHERE kind='products' AND json_extract(data,'$.name')=? AND json_extract(data,'$.axis')=?").get(p.name,p.axis)||products.some((x,j)=>j!==i&&x.name===p.name&&x.axis===p.axis))errors.push('상품명·운영축 중복')}
 const nums=[...sets.students.values()].map(r=>r.number);if(new Set(nums).size!==nums.length)errors.push('배치 내 중복 등록번호');
 const es=[...sets.enrollments.values()];for(let i=0;i<es.length;i++)for(let j=i+1;j<es.length;j++)if(es[i].student_key===es[j].student_key&&es[i].start<=(es[j].end||'9999-12-31')&&es[j].start<=(es[i].end||'9999-12-31'))errors.push('배치 내 수강기간 중복');
 return {ok:errors.length===0,counts,errors,excluded,fingerprint:digest(input)};
}
export function applyImport(context,input){const {db,save,validate,event,atomic}=context;return atomic(()=>{
 if(db.prepare('SELECT value FROM metadata WHERE key=?').get('lifecycle')?.value==='operating')reject('웹 운영 시작 후 이관을 실행할 수 없습니다',409);
 const fingerprint=digest(input),existing=db.prepare('SELECT * FROM import_batches WHERE id=?').get(input.batch_id);
 if(existing){if(existing.fingerprint!==fingerprint)reject('같은 배치ID의 입력이 다릅니다',409);if(existing.status==='rolled_back')reject('되돌린 배치는 새 배치ID로 다시 검수하세요',409);return {replayed:true,counts:JSON.parse(existing.counts)}}
 const preview=previewImport(db,input);if(!preview.ok)reject('이관 검수 실패: '+preview.errors.join(' / '));
 const ids={};for(const kind of Object.keys(allowed)){ids[kind]=new Map();for(const row of input[kind]||[]){if(kind==='lessons'&&Object.keys(row).every(k=>['source_key','id'].includes(k)))continue;
  const {source_key,student_key,product_key,enrollment_key,...data}=row;
  if(student_key)data.student=ids.students.get(student_key);if(product_key)data.product=ids.products.get(product_key);if(enrollment_key)data.enrollment=ids.enrollments.get(enrollment_key);
  validate(kind,data);const record=save(kind,data);ids[kind].set(source_key,record.id);db.prepare('INSERT INTO import_mapping VALUES(?,?,?,?)').run(input.batch_id,kind,source_key,record.id);
  if(kind==='students'){db.prepare('INSERT INTO number_history VALUES(?)').run(record.number);db.prepare('UPDATE counters SET value=max(value,?)').run(Number(record.number.slice(4)))}
 }}
 db.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?,?)').run(input.batch_id,fingerprint,'applied',new Date().toISOString(),JSON.stringify(preview.counts),JSON.stringify({source:input.source,cutoff:input.cutoff}));event('import','합성/승인 스냅샷 배치 확정',null);return {replayed:false,counts:preview.counts,excluded:preview.excluded};
})}
export function rollbackImport(context,batch){const {db,atomic,event}=context;return atomic(()=>{
 if(db.prepare('SELECT value FROM metadata WHERE key=?').get('lifecycle')?.value==='operating')reject('운영 시작 후 배치 되돌리기를 사용할 수 없습니다',409);
 const existing=db.prepare('SELECT * FROM import_batches WHERE id=?').get(batch);if(!existing)reject('배치 없음',404);if(existing.status==='rolled_back')return {replayed:true};
 const mapping=db.prepare('SELECT * FROM import_mapping WHERE batch=?').all(batch),ids=new Set(mapping.map(r=>r.target));
 for(const m of mapping){const r=db.prepare('SELECT * FROM records WHERE id=?').get(m.target);if(!r||r.version!==1)reject('배치 기록이 수정되었습니다. 신규 입력 보존 복구가 필요합니다',409);if(m.kind==='students'&&db.prepare('SELECT 1 FROM accounts WHERE student=?').get(m.target))reject('활성화된 계정이 있어 자동 되돌리기를 보류합니다',409)}
 for(const r of db.prepare('SELECT * FROM records').all()){const data=JSON.parse(r.data);if(!ids.has(r.id)&&['student','product','enrollment'].some(k=>ids.has(data[k])))reject('배치 밖 연결 기록이 있어 자동 되돌리기를 보류합니다',409)}
 for(const m of [...mapping].sort((a,b)=>({lessons:0,enrollments:1,products:2,students:3}[a.kind]-{lessons:0,enrollments:1,products:2,students:3}[b.kind])))db.prepare('DELETE FROM records WHERE id=?').run(m.target);
 db.prepare('UPDATE import_batches SET status=? WHERE id=?').run('rolled_back',batch);event('import','운영 전 배치 되돌림',null);return {replayed:false};
})}
