import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {backup,DatabaseSync} from 'node:sqlite';
import {mkdtempSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
process.env.NODE_ENV='test';process.env.DB_PATH=':memory:';
const {server,db,seed,setTestClock,setTestFault,operations,sweep,applyDeletionJournal,inspectIntegrity}=await import('./server.mjs');
const START=Date.parse('2026-10-03T06:00:00Z'),DUE=START+10*60000;
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
let admin,s,enrollment;
async function call(p,b,c=admin,m=b?'POST':'GET'){const r=await fetch(base+'/api/'+p,{method:m,headers:{'Content-Type':'application/json',Cookie:c||''},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}
const list=async k=>(await call('admin/'+k)).data;
const key=()=>crypto.randomUUID();
const renew=async()=>{admin=(await call('login',{id:'director-demo',password:'Demo-Director-2026!',mode:'director'},'')).cookie};
const policyBody=(p,over={})=>Object.fromEntries(Object.entries({...p,...over,operation_id:key()}).filter(([k])=>!['mode','provider_ready'].includes(k)));
const eventBody=(over={})=>({operation_id:key(),kind:'수업',date:'2026-10-04',time:'15:10',duration:50,status:'확정',student:s.id,visitor:null,enrollment:enrollment.id,recipient:'본인',reminder:true,recipient_confirmed:true,type:'정규',room:'',reason:'',result:'',...over});
const savedBody=(e,over={})=>eventBody(Object.fromEntries(Object.entries({...e,...over,operation_id:key()}).filter(([k])=>['id','version','operation_id','kind','date','time','duration','status','student','visitor','enrollment','recipient','reminder','recipient_confirmed','type','room','reason','result','scope'].includes(k))));
const create=async over=>{const r=await call('admin/calendar',eventBody(over));assert.equal(r.status,200,JSON.stringify(r.data));return r.data};
beforeEach(async()=>{
 setTestFault(null);setTestClock(START);operations.setMockOutcome('전달 성공');
 db.exec('DELETE FROM op_history; DELETE FROM op_attempts; DELETE FROM op_alerts; DELETE FROM op_calendar; DELETE FROM op_series; DELETE FROM op_visitors; DELETE FROM op_mutations; DELETE FROM op_mock_receipts; DELETE FROM op_settings;');
 db.exec("DELETE FROM records WHERE kind='lessons'; DELETE FROM records WHERE kind='enrollments';");
 for(const t of ['records','accounts','sessions','operations','audit','verification','account_operations','number_history','policy_runs','retention_jobs','failures','import_mapping','import_batches'])db.exec('DELETE FROM '+t);
 db.exec('DELETE FROM deletion_journal.entries');db.prepare('UPDATE counters SET value=742').run();seed();db.prepare('UPDATE accounts SET initial_until=? WHERE student IS NOT NULL').run(START+DAY);
 db.prepare('INSERT INTO op_settings VALUES(1,?)').run(JSON.stringify({version:1,enabled:true,minutes_before:1440,kinds:['수업'],template:'[피아노를 담다] {이름}님 {날짜} {시간} {종류} 안내',daily_limit:30,visitor_retention_days:null,retention_confirmed:false}));
 admin=(await call('login',{id:'director-demo',password:'Demo-Director-2026!',mode:'director'},'')).cookie;
 s=(await list('students'))[0];s=(await call('admin/students/'+s.id,{...s,contact:'01000000001',guardian_contact:'01000000002',operation_id:key()},admin,'PUT')).data;enrollment=(await list('enrollments'))[0];
});
const DAY=86400000;
after(()=>{server.close();db.close()});

test('OP-T01/02 대시보드: 정기 메모 제외·확정 종류별 집계·KST 날짜',async()=>{
 const empty=(await call('admin/dashboard?date=2026-10-03')).data;assert.equal(empty.registered,0);assert.equal(empty.counts.수업,0);
 await create({date:'2026-10-03',time:'23:30',reminder:false,recipient_confirmed:false});
 await create({kind:'상담',date:'2026-10-04',time:'00:30',enrollment:null,reminder:false,recipient_confirmed:false});
 const today=(await call('admin/dashboard?date=2026-10-03')).data;assert.equal(today.counts.수업,1);assert.equal(today.items.length,1);
 setTestClock(Date.parse('2026-10-03T15:00:00Z'));admin=(await call('login',{id:'director-demo',password:'Demo-Director-2026!',mode:'director'},'')).cookie;
 assert.equal((await call('admin/dashboard')).data.date,'2026-10-04');assert.equal((await call('admin/dashboard')).data.counts.상담,1);
 assert.equal((await call('admin/dashboard?date=2026-02-30')).status,400);
});
test('OP-T04/22 종류간 충돌·동시 저장·종료시각 경계',async()=>{
 const responses=await Promise.all([call('admin/calendar',eventBody({reminder:false})),call('admin/calendar',eventBody({kind:'상담',enrollment:null,reminder:false}))]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 await create({kind:'체험',enrollment:null,time:'16:00',reminder:false});assert.equal((await list('calendar?from=2026-10-04&to=2026-10-04')).length,2);
});
test('OP-T05 수강기간·휴원·휴무·잘못된 연결과 입력',async()=>{
 for(const over of [{date:'2026-08-31'},{visitor:9},{duration:0},{time:'24:00'},{student:'1'},{type:'틀림'}])assert.equal((await call('admin/calendar',eventBody(over))).status,400);
 await create({kind:'휴무',student:null,enrollment:null,time:'14:30',duration:120,reminder:false,recipient_confirmed:false});
 assert.equal((await call('admin/calendar',eventBody())).status,409);
 s=(await call('admin/students/'+s.id,{...s,status:'휴원',operation_id:key()},admin,'PUT')).data;
 assert.equal((await call('admin/calendar',eventBody({time:'18:00'}))).status,400);
});
test('OP-T04 두 화면 버전 충돌·변경 이력',async()=>{
 const e=await create();const b=savedBody(e,{time:'16:10',reason:'시간 이동'});const r=await call('admin/calendar/'+e.id,b,admin,'PUT');assert.equal(r.status,200);
 assert.equal((await call('admin/calendar/'+e.id,{...b,operation_id:key()},admin,'PUT')).status,409);
 const detail=(await call('admin/calendar/'+e.id)).data;assert.equal(detail.history.length,2);assert.ok(detail.history[0].before_data.includes('15:10'));
});
test('OP-T24 일정·알림 원자성과 응답유실 동일키 재시도',async()=>{
 const b=eventBody();setTestFault('operations-after-save');assert.equal((await call('admin/calendar',b)).status,500);assert.equal(db.prepare('SELECT count(*) n FROM op_calendar').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM op_alerts').get().n,0);
 setTestFault(null);const one=await call('admin/calendar',b),two=await call('admin/calendar',b);assert.equal(one.data.id,two.data.id);assert.equal(db.prepare('SELECT count(*) n FROM op_history').get().n,1);assert.equal((await call('admin/calendar',{...b,time:'17:00'})).status,409);
});
test('OP-T08 일정 확정은 수업 기록·공개·회차를 생성하지 않음',async()=>{
 const before=(await list('lessons')).length,e=await create();assert.equal((await list('lessons')).length,before);assert.equal(e.lesson_id,null);
 const b={student:s.id,enrollment:enrollment.id,date:e.date,time:e.time,type:'정규',status:'예정',published:false,operation_id:key()};
 const l=await call('admin/lessons',b);assert.equal(l.status,200);assert.equal((await call('admin/calendar/'+e.id)).data.event.lesson_id,l.data.id);
 await call('admin/lessons/'+l.data.id,{},admin,'DELETE');assert.equal((await call('admin/calendar/'+e.id)).data.event.lesson_id,null);
});
test('OP-T06 중복 반복 생성·일부 충돌 시 전체 롤백',async()=>{
 const b=eventBody({until:'2026-10-25'}),p=await call('admin/repeat-preview',b);assert.equal(p.data.items.length,4);
 const a=await call('admin/repeat',b),again=await call('admin/repeat',b);assert.equal(a.status,200);assert.equal(a.data.series,again.data.series);assert.equal(db.prepare('SELECT count(*) n FROM op_calendar').get().n,4);
 const conflict=await call('admin/repeat',eventBody({until:'2026-11-01'}));assert.equal(conflict.status,409);assert.equal(db.prepare('SELECT count(*) n FROM op_calendar').get().n,4);
});
test('OP-T07 이번 회차/이후 회차 변경과 기존 예외 보존',async()=>{
 const rows=(await call('admin/repeat',eventBody({until:'2026-10-25'}))).data.items;
 await call('admin/calendar/'+rows[1].id,savedBody(rows[1],{time:'17:00',scope:'single',reason:'개별 이동'}),admin,'PUT');
 const update=await call('admin/calendar/'+rows[2].id,savedBody(rows[2],{time:'16:10',scope:'future',reason:'이후 변경'}),admin,'PUT');assert.equal(update.status,200);assert.equal(update.data.items.length,2);
 assert.equal(operations.calendar().find(e=>e.id===rows[0].id).time,'15:10');assert.equal(operations.calendar().find(e=>e.id===rows[1].id).time,'17:00');
});
test('OP-T06 반복 미리보기는 휴무 예외를 표시하고 미확정 후보를 저장하지 않음',async()=>{
 await create({kind:'휴무',student:null,enrollment:null,date:'2026-10-11',time:'14:00',duration:180,reminder:false,recipient_confirmed:false});
 const b=eventBody({until:'2026-10-25'}),p=(await call('admin/repeat-preview',b)).data;assert.equal(p.ok,false);assert.match(p.items[1].error,/겹칩니다/);assert.equal((await call('admin/repeat',b)).status,409);assert.equal(operations.calendar().length,1);
});
test('OP-T09 연락처 누락·보호자 명시·문구 허용 항목',async()=>{
 const p=(await call('admin/calendar-preview',eventBody({recipient:'보호자'}))).data;assert.match(p.masked_contact,/0002$/);assert.match(p.text,/2026-10-04 15:10/);assert.equal(p.cost,null);
 await create({recipient:'보호자'});assert.equal((await list('alerts'))[0].recipient,'보호자');assert.equal(db.prepare('SELECT count(*) n FROM op_alerts').get().n,1);
 s=(await call('admin/students/'+s.id,{...s,contact:'',operation_id:key()},admin,'PUT')).data;
 assert.equal((await call('admin/calendar',eventBody({time:'18:00'}))).status,400);
 const pol=await list('alert-policy');assert.equal((await call('admin/alert-policy',policyBody(pol,{kinds:['수업','상담'],template:'{이름} {날짜} {시간} 수업'}),admin,'PUT')).status,400);assert.equal((await call('admin/alert-policy',policyBody(pol,{template:'{내부메모} {날짜} {시간}'}),admin,'PUT')).status,400);
});
test('OP-T10 연락처 변경 후 발송 보류·다른 번호로 자동 대체 없음',async()=>{
 const e=await create();s=(await call('admin/students/'+s.id,{...s,contact:'01000000003',operation_id:key()},admin,'PUT')).data;
 setTestClock(DUE);const r=operations.runAlerts();assert.equal(r.sent,0);assert.equal((await list('alerts'))[0].status,'보류');assert.equal(db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,0);
});
test('OP-T10 템플릿 변경 후 재확인 필요',async()=>{
 const e=await create(),p=await list('alert-policy');await call('admin/alert-policy',policyBody(p,{template:'안내 {이름} {날짜} {시간}'}),admin,'PUT');
 setTestClock(DUE);assert.equal(operations.runAlerts().sent,0);assert.match((await list('alerts'))[0].reason,/재확인/);
});
test('OP-T11 예약시각 자동 처리·중복 실행·모의 접수 한 번',async()=>{
 await create();assert.equal(operations.runAlerts().sent,0);setTestClock(DUE);assert.equal(operations.runAlerts().sent,1);assert.equal(operations.runAlerts().sent,0);assert.equal((await list('alerts'))[0].status,'전달 성공');assert.equal(db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,1);
});
test('OP-T12 접수 후 응답 유실: 조회로 복구하고 재발송하지 않음',async()=>{
 await create();setTestClock(DUE);setTestFault('alert-after-provider');operations.runAlerts();assert.equal((await list('alerts'))[0].status,'결과 확인 중');setTestFault(null);operations.runAlerts();assert.equal((await list('alerts'))[0].status,'전달 성공');assert.equal(db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM op_attempts').get().n,1);
});
test('OP-T24 점유 후 장애: 결과 불명은 자동 재발송/재시도 차단',async()=>{
 await create();setTestClock(DUE);setTestFault('alert-after-claim');operations.runAlerts();setTestFault(null);setTestClock(DUE+60000);assert.equal(operations.runAlerts().sent,0);const job=(await list('alerts'))[0];assert.equal(job.status,'결과 확인 중');assert.equal((await call('admin/alerts-retry/'+job.id,{version:job.version})).status,409);
});
test('OP-T13 확인된 실패만 재시도·성공 건 제외',async()=>{
 const failedEvent=await create({duration:5});await create({time:'15:15',duration:5});setTestClock(DUE);operations.setMockOutcome('전달 실패');operations.runAlerts();let j=(await list('alerts'))[0];assert.equal(j.status,'전달 실패');operations.setMockOutcome('전달 성공');setTestClock(DUE+5*60000);assert.equal(operations.runAlerts().sent,1);assert.equal((await call('admin/calendar/'+failedEvent.id,savedBody(failedEvent,{reason:'실패 후 대상 재확인'}),admin,'PUT')).status,200);assert.equal(operations.runAlerts().sent,0);j=(await list('alerts'))[0];assert.equal(j.status,'전달 실패');assert.equal((await call('admin/alerts-retry/'+j.id,{version:j.version})).status,200);assert.equal(operations.runAlerts().sent,1);j=(await list('alerts'))[0];assert.equal((await call('admin/alerts-retry/'+j.id,{version:j.version})).status,409);assert.equal(db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,3);
});
test('OP-T14 미연결 업체 통지·학생 POST·임의 운영 기능 거부',async()=>{
 assert.equal((await call('provider/callback',{id:'위조',status:'전달 성공'},'')).status,401);assert.equal((await call('admin/provider-callback',{id:'위조'})).status,404);assert.equal((await call('admin/calendar',null,admin,'DELETE')).status,404);
});
test('OP-T15 일정 취소·이동 시 기존 대기 알림 갱신',async()=>{
 const e=await create(),move=await call('admin/calendar/'+e.id,savedBody(e,{time:'17:10',reason:'시간 이동'}),admin,'PUT');assert.equal(move.status,200);let j=(await list('alerts'))[0];assert.equal(j.due,DUE+120*60000);
 setTestClock(DUE);assert.equal(operations.runAlerts().sent,0);
 const cancel=await call('admin/calendar/'+e.id,savedBody(move.data,{status:'취소',reason:'예약 취소'}),admin,'PUT');assert.equal(cancel.status,200);setTestClock(DUE+120*60000);await renew();assert.equal(operations.runAlerts().sent,0);assert.equal((await list('alerts'))[0].status,'발송 전 취소');
});
test('OP-T15 이미 보낸 수업 시간/수신자 변경은 동일 알림을 재발송하지 않음',async()=>{
 const e=await create();setTestClock(DUE);operations.runAlerts();const r=await call('admin/calendar/'+e.id,savedBody(e,{time:'17:10',recipient:'보호자',reason:'변경 후 검토'}),admin,'PUT');assert.equal(r.status,200);setTestClock(DUE+120*60000);assert.equal(operations.runAlerts().sent,0);assert.equal(db.prepare('SELECT count(*) n FROM op_alerts').get().n,1);
});
test('OP-T16 학생은 전체 운영 API와 연락처·문자 조회 차단',async()=>{
 const a=await call('login',{id:s.number,password:'1234',mode:'student'},'');const normal=await call('password',{password:'Operations-Student-2026!',confirm:'Operations-Student-2026!'},a.cookie);
 for(const p of ['dashboard','calendar','visitors','alerts','alert-policy'])assert.equal((await call('admin/'+p,null,normal.cookie)).status,403);
 const view=(await call('student',null,normal.cookie)).data;assert.equal(view.contact,undefined);assert.equal(view.alerts,undefined);assert.equal(view.calendar,undefined);
});
test('OP-T17 학생 파기·예약/문자/시도 삭제·복원 재적용',async()=>{
 await create();setTestClock(DUE);operations.runAlerts();const eBackup=db.prepare('SELECT * FROM op_calendar').get(),sBackup=db.prepare('SELECT * FROM records WHERE id=?').get(s.id),enBackup=db.prepare('SELECT * FROM records WHERE id=?').get(enrollment.id);
 await call('admin/students/'+s.id,{},admin,'DELETE');sweep('2027-04-03T07:00:00Z');for(const t of ['op_calendar','op_alerts','op_attempts','op_mock_receipts'])assert.equal(db.prepare('SELECT count(*) n FROM '+t).get().n,0);
 db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(sBackup.kind,sBackup.id,sBackup.data,sBackup.version);db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(enBackup.kind,enBackup.id,enBackup.data,enBackup.version);db.prepare('INSERT INTO op_calendar VALUES(?,?,?,?,?)').run(eBackup.id,eBackup.data,eBackup.version,eBackup.series,eBackup.occurrence);
 applyDeletionJournal();assert.equal(operations.calendar().length,0);assert.equal(inspectIntegrity().ok,true);
});
test('OP-T18 실제 운영 모드에서도 업체 미연결 발송 차단',async()=>{
 await create();setTestClock(DUE);process.env.APP_MODE='production';try{const r=operations.runAlerts();assert.equal(r.sent,0);assert.equal(r.external_calls,0)}finally{delete process.env.APP_MODE}assert.match((await list('alerts'))[0].reason,/연결 미설정/);
});
test('OP-T20 오래된 작업 보류·전체 중단·복원 후 비활성',async()=>{
 const e=await create();setTestClock(DUE+6*60000);operations.runAlerts();assert.match((await list('alerts'))[0].reason,/이미 지남/);
 setTestClock(START);const p=await list('alert-policy');await call('admin/alert-policy',policyBody(p,{enabled:false}),admin,'PUT');assert.equal(operations.runAlerts().sent,0);
 applyDeletionJournal();await renew();assert.equal(operations.policy().enabled,false);assert.ok((await list('alerts')).every(j=>j.status!=='발송 대기'));
});
test('OP-T21 상담·체험 방문자: 수강·학생 계정 없이 예약',async()=>{
 const count=(await list('students')).length,accounts=db.prepare('SELECT count(*) n FROM accounts').get().n;
 const v=(await call('admin/visitors',{operation_id:key(),name:'합성 체험 방문자',contact:'01000000009',guardian_contact:'',relation:'본인',contact_confirmed:true})).data;
 for(const [kind,time] of [['상담','10:00'],['체험','11:00']])await create({kind,time,student:null,visitor:v.id,enrollment:null,reminder:false});assert.equal((await list('students')).length,count);assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n,accounts);
});
test('OP-T23 방문자 보존 미확정은 자동 파기하지 않으며 확정 후 삭제목록 재적용',async()=>{
 const v=(await call('admin/visitors',{operation_id:key(),name:'합성 보존 방문자',contact:'01000000009',guardian_contact:'',relation:'본인',contact_confirmed:true})).data;await create({kind:'상담',time:'10:00',student:null,visitor:v.id,enrollment:null,reminder:false});sweep('2027-01-01T00:00:00Z');assert.equal((await list('visitors')).length,1);
 const p=await list('alert-policy');await call('admin/alert-policy',policyBody(p,{visitor_retention_days:30,retention_confirmed:true}),admin,'PUT');const backup=db.prepare('SELECT * FROM op_visitors').get();sweep('2027-01-01T00:00:00Z');assert.equal((await list('visitors')).length,0);db.prepare('INSERT INTO op_visitors VALUES(?,?,?)').run(backup.id,backup.data,backup.version);applyDeletionJournal();await renew();assert.equal((await list('visitors')).length,0);
});
test('OP-T25 일일 상한·실패/응답유실 접수도 합산·KST 경계',async()=>{
 const p=await list('alert-policy');await call('admin/alert-policy',policyBody(p,{daily_limit:1}),admin,'PUT');
 await create({time:'15:10',duration:5});await create({time:'15:15',duration:5});setTestClock(DUE);setTestFault('alert-after-provider');operations.runAlerts();setTestFault(null);setTestClock(DUE+5*60000);operations.runAlerts();const js=await list('alerts');assert.equal(js.filter(j=>j.status==='전달 성공').length,1);assert.match(js.find(j=>j.status==='보류').reason,/상한/);
});
test('OP-T05 등록 종료 직후 대기 알림 보류·대시보드 확인 목록',async()=>{
 await create();await call('admin/students/'+s.id,{...s,status:'휴원',operation_id:key()},admin,'PUT');const d=(await call('admin/dashboard?date=2026-10-04')).data;assert.ok(d.tasks.some(t=>t.kind==='일정 검토'));assert.equal((await list('alerts'))[0].status,'보류');setTestClock(DUE);assert.equal(operations.runAlerts().sent,0);
});
test('OP-T06 휴무 회차를 명시적으로 제외한 반복 저장',async()=>{
 await create({kind:'휴무',student:null,enrollment:null,date:'2026-10-11',time:'14:00',duration:180,reminder:false,recipient_confirmed:false});
 const b=eventBody({until:'2026-10-25',skip_dates:['2026-10-11']}),p=(await call('admin/repeat-preview',b)).data;assert.equal(p.ok,true);assert.equal(p.items.filter(i=>i.skipped).length,1);const r=await call('admin/repeat',b);assert.equal(r.status,200);assert.equal(r.data.items.length,3);assert.equal((await call('admin/repeat',{...b,operation_id:key(),skip_dates:['2026-10-12']})).status,400);
});
test('OP-T23 방문자와 기존 학생의 명시적 연결·중복 학생 생성 없음',async()=>{
 const v=(await call('admin/visitors',{operation_id:key(),name:'합성 연결 방문자',contact:'01000000009',guardian_contact:'',relation:'본인',contact_confirmed:true})).data;
 const e=await create({kind:'체험',time:'10:00',student:null,visitor:v.id,enrollment:null,reminder:false});
 const b={operation_id:key(),version:v.version,student:s.id,verified:true};assert.equal((await call('admin/visitor-link/'+v.id,{...b,verified:false})).status,400);const r=await call('admin/visitor-link/'+v.id,b);assert.equal(r.status,200);const linked=(await call('admin/calendar/'+e.id)).data.event;assert.equal(linked.student,s.id);assert.equal(linked.visitor,null);assert.equal(linked.reminder,false);assert.equal((await list('students')).length,1);assert.equal((await call('admin/visitor-link/'+v.id,b)).status,200);
});
test('운영 참조 무결성: 저장소 직접 잘못된 학생과 연결 삭제 차단',async()=>{
 const e=await create();assert.throws(()=>db.prepare('UPDATE op_calendar SET data=? WHERE id=?').run(JSON.stringify({...e,student:999999}),e.id));assert.throws(()=>db.prepare('DELETE FROM records WHERE id=?').run(enrollment.id));assert.equal(inspectIntegrity().ok,true);
});
test('OP-T11/24 두 실행기의 같은 DB 경쟁: 모의 접수 1회',async()=>{
 await create();const dir=mkdtempSync(path.join(tmpdir(),'academy-ops-multiproc-')),file=path.join(dir,'worker.sqlite');
 try{await backup(db,file);const source=`import {operations,setTestClock,db} from ${JSON.stringify(new URL('./server.mjs',import.meta.url).href)};setTestClock(${DUE});console.log(JSON.stringify(operations.runAlerts()));db.close();`;
  const worker=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,NODE_ENV:'test',DB_PATH:file},windowsHide:true});let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(Error(error)));});
  const results=await Promise.all([worker(),worker()]);assert.equal(results.reduce((n,r)=>n+r.sent,0),1);const check=new DatabaseSync(file);try{assert.equal(check.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,1);assert.equal(check.prepare("SELECT count(*) n FROM op_alerts WHERE status='전달 성공'").get().n,1)}finally{check.close()}
 }finally{for(const suffix of ['', '.deletions.sqlite','-journal','.deletions.sqlite-journal'])if(existsSync(file+suffix))unlinkSync(file+suffix);rmdirSync(dir)}
});
test('OP-T09 같은 번호는 공유 경고·학생별 일정 알림을 임의로 합치지 않음',async()=>{
 const other=(await call('admin/students',{operation_id:key(),name:'합성 공유 번호 학생',contact:s.contact,axis:'성인 스튜디오',status:'재원',minor:false})).data;
 const next=(await call('admin/enrollments',{operation_id:key(),student:other.id,product:enrollment.product,start:'2026-10-01',end:'',division:'교습소',status:'유효'})).data;
 assert.equal((await call('admin/calendar-preview',eventBody())).data.shared_targets,1);
 await create({duration:5});await create({student:other.id,enrollment:next.id,time:'15:15',duration:5});setTestClock(DUE+5*60000);assert.equal(operations.runAlerts().sent,2);assert.equal(db.prepare('SELECT count(*) n FROM op_alerts').get().n,2);
});
test('OP-T25 두 실행기·두 작업 경쟁에서도 일일 상한 준수',async()=>{
 const p=await list('alert-policy');await call('admin/alert-policy',policyBody(p,{daily_limit:1}),admin,'PUT');await create({duration:5});await create({time:'15:15',duration:5});
 const dir=mkdtempSync(path.join(tmpdir(),'academy-ops-multiproc-')),file=path.join(dir,'worker.sqlite');
 try{await backup(db,file);const source=`import {operations,setTestClock,db} from ${JSON.stringify(new URL('./server.mjs',import.meta.url).href)};setTestClock(${DUE+5*60000});console.log(JSON.stringify(operations.runAlerts()));db.close();`;
  const worker=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,NODE_ENV:'test',DB_PATH:file},windowsHide:true});let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(Error(error)));});
  const results=await Promise.all([worker(),worker()]);assert.equal(results.reduce((n,r)=>n+r.sent,0),1);const check=new DatabaseSync(file);try{assert.equal(check.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,1);assert.equal(check.prepare("SELECT count(*) n FROM op_alerts WHERE status='보류'").get().n,1)}finally{check.close()}
 }finally{for(const suffix of ['', '.deletions.sqlite','-journal','.deletions.sqlite-journal'])if(existsSync(file+suffix))unlinkSync(file+suffix);rmdirSync(dir)}
});
