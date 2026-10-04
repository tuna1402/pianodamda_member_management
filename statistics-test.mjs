import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.DB_PATH=':memory:';
const {server,db,seed,setTestClock}=await import('./server.mjs');
const {statistics}=await import('./statistics.mjs');
const now=Date.parse('2026-10-03T14:59:59Z');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let admin,student,enrollment;
async function call(url,body,cookie=admin,method=body?'POST':'GET'){const response=await fetch(base+'/api/'+url,{method,headers:{'Content-Type':'application/json',Cookie:cookie||''},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}}
function event(date,{kind='수업',status='확정',id=crypto.randomUUID()}={}){db.prepare('INSERT INTO op_calendar(id,data) VALUES(?,?)').run(id,JSON.stringify({date,kind,status,student:student.id,enrollment:kind==='수업'?enrollment.id:null,time:'14:00',duration:50,reminder:false}));return id}
function lesson(date,{status='완료',published=true}={}){return db.prepare('INSERT INTO records(kind,data) VALUES(?,?)').run('lessons',JSON.stringify({date,status,published,student:student.id,enrollment:enrollment.id,time:'14:00',internal:'SECRET_INTERNAL',task:'과제'})).lastInsertRowid}
beforeEach(async()=>{
 setTestClock(now);
 db.exec('DELETE FROM op_calendar; DELETE FROM op_series; DELETE FROM op_mutations; DELETE FROM op_mock_receipts; DELETE FROM sessions; DELETE FROM failures;');
 seed();db.exec("DELETE FROM records WHERE kind='lessons'");
 student=JSON.parse(db.prepare("SELECT data FROM records WHERE kind='students' LIMIT 1").get().data);student.id=db.prepare("SELECT id FROM records WHERE kind='students' LIMIT 1").get().id;
 enrollment=db.prepare("SELECT id FROM records WHERE kind='enrollments' LIMIT 1").get();
 db.prepare('UPDATE accounts SET initial_until=? WHERE student IS NOT NULL').run(now+86400000);
 admin=(await call('login',{id:'director-demo',password:'Demo-Director-2026!',mode:'director'},'')).cookie;
});
after(()=>{server.close();db.close()});

test('통계: 7일 경계·종류·상태와 완료 수업의 공개 여부를 별도 집계',async()=>{
 event('2026-09-26');event('2026-10-04');event('2026-09-27');event('2026-10-03',{kind:'상담'});event('2026-10-03',{kind:'체험'});
 for(const options of [{status:'임시'},{status:'취소'},{kind:'휴무'}])event('2026-10-03',options);
 lesson('2026-09-27');lesson('2026-10-03',{published:false});lesson('2026-09-26');lesson('2026-10-04');for(const status of ['예정','임시','취소','무효'])lesson('2026-10-03',{status});
 const response=await call('admin/statistics?anchor=2026-10-03&period=7d');assert.equal(response.status,200);const data=response.data;
 assert.equal(data.from,'2026-09-27');assert.equal(data.buckets.length,7);assert.equal(data.bucket_days,1);
 assert.deepEqual(data.totals,{classes:1,consultations:1,trials:1,confirmed:3,completed:2,today_confirmed:2});
 assert.deepEqual(data.buckets[0],{from:'2026-09-27',to:'2026-09-27',classes:1,consultations:0,trials:0,completed:1,total:1});
 assert.equal(data.buckets[3].total,0);assert.equal(data.buckets[6].completed,1);
 assert.ok(!JSON.stringify(data).includes('SECRET_INTERNAL'));assert.ok(!JSON.stringify(data).includes('student'));
});
test('통계: 최근 28일을 연속 7일씩 네 구간으로 나누고 합계 일치',()=>{
 for(const date of ['2026-09-06','2026-09-12','2026-09-13','2026-09-19','2026-09-20','2026-09-26','2026-09-27','2026-10-03']){event(date);lesson(date)}
 event('2026-09-05');event('2026-10-04');
 const data=statistics(db,{anchor:'2026-10-03',period:'28d',now});
 assert.equal(data.from,'2026-09-06');assert.equal(data.bucket_days,7);assert.deepEqual(data.buckets.map(b=>[b.from,b.to,b.total,b.completed]),[['2026-09-06','2026-09-12',2,2],['2026-09-13','2026-09-19',2,2],['2026-09-20','2026-09-26',2,2],['2026-09-27','2026-10-03',2,2]]);
 assert.equal(data.totals.confirmed,8);assert.equal(data.totals.completed,8);
});
test('통계: KST 자정 기본 날짜와 실제 오늘 카드가 선택 과거 날짜와 다름',async()=>{
 event('2026-10-03');event('2026-10-04',{kind:'상담'});event('2026-10-04',{kind:'체험'});
 assert.equal((await call('admin/statistics')).data.anchor,'2026-10-03');
 setTestClock(now+1000);
 const next=(await call('admin/statistics')).data;assert.equal(next.anchor,'2026-10-04');assert.equal(next.totals.today_confirmed,2);
 const past=(await call('admin/statistics?anchor=2026-10-03')).data;assert.equal(past.today,'2026-10-04');assert.equal(past.totals.today_confirmed,2);assert.equal(past.totals.confirmed,1);
});
test('통계: 모든 알림 상태와 미래 알림은 전체 범위, 미등록 상태 누락 없음',()=>{
 const id=event('2026-12-25');const states=['발송 대기','보류','처리 중','업체 접수','전달 성공','전달 실패','결과 확인 중','발송 전 취소','추가 업체 상태'];
 for(const [i,status] of states.entries())db.prepare('INSERT INTO op_alerts(id,event_id,recipient,version,policy_version,status,due) VALUES(?,?,?,?,?,?,?)').run('alert'+i,id,'recipient'+i,1,1,status,now+1000000000);
 const data=statistics(db,{anchor:'2026-10-03',now});assert.equal(data.alerts.total,9);assert.equal(data.alerts.attention,4);assert.equal(data.alerts.items.length,9);assert.ok(data.alerts.items.every(item=>item.count===1));assert.equal(data.totals.confirmed,0);
});
test('통계: 취소·수업 무효·관계 파기 뒤 현재 집계와 알림 동기화',()=>{
 const id=event('2026-10-03');const record=lesson('2026-10-03');db.prepare('INSERT INTO op_alerts(id,event_id,recipient,version,policy_version,status) VALUES(?,?,?,?,?,?)').run('job',id,'본인',1,1,'보류');
 assert.equal(statistics(db,{now}).totals.confirmed,1);
 db.prepare("UPDATE op_calendar SET data=json_set(data,'$.status','취소') WHERE id=?").run(id);db.prepare("UPDATE records SET data=json_set(data,'$.status','무효') WHERE id=?").run(record);
 let data=statistics(db,{now});assert.equal(data.totals.confirmed,0);assert.equal(data.totals.completed,0);assert.equal(data.alerts.total,1);
 db.prepare('DELETE FROM op_calendar WHERE id=?').run(id);data=statistics(db,{now});assert.equal(data.alerts.total,0);
});
test('통계: 정상 빈 기간·윤일·잘못된 날짜/기간/메소드 검증',async()=>{
 assert.equal(statistics(db,{anchor:'2024-02-29',now}).buckets.length,7);
 assert.equal(statistics(db,{anchor:'2026-01-31',period:'28d',now}).from,'2026-01-04');
 for(const query of ['anchor=2026-02-30','anchor=bad','anchor=','period=365d','period='])assert.equal((await call('admin/statistics?'+query)).status,400);
 assert.equal((await call('admin/statistics',{})).status,405);assert.equal((await call('admin/statistics/1')).status,405);
 const empty=(await call('admin/statistics')).data;assert.equal(empty.totals.confirmed,0);assert.equal(empty.totals.completed,0);assert.ok(empty.buckets.every(b=>b.total===0));
});
test('통계: 비로그인·학생 제한 세션·일반 학생의 직접 API 접근 차단',async()=>{
 assert.equal((await call('admin/statistics',null,'')).status,401);
 const login=await call('login',{id:'MBR-000742',password:'1234',mode:'student'},'');assert.equal(login.status,200);
 assert.equal((await call('admin/statistics',null,login.cookie)).status,403);
 const changed=await call('password',{password:'Stats-Student-2026!',confirm:'Stats-Student-2026!'},login.cookie);assert.equal(changed.status,200);
 assert.equal((await call('admin/statistics',null,changed.cookie)).status,403);
 const s=await call('student',null,changed.cookie);assert.equal(s.status,200);assert.ok(!JSON.stringify(s.data).includes('op_alerts'));
});
test('정적 에셋: 사진/SVG/차트 정상 MIME·HEAD와 CSP',async()=>{
 for(const [url,type] of [['/assets/piano-studio-hero.png','image/png'],['/assets/music-line.svg','image/svg+xml'],['/charts.js','text/javascript']]){const response=await fetch(base+url);assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-security-policy'),/object-src 'none'/);assert.ok((await response.arrayBuffer()).byteLength>0)}
 const head=await fetch(base+'/assets/music-line.svg',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});
test('정적 에셋: 없는 URL·DB·설정·경로 변형·POST는 공개하지 않음',async()=>{
 for(const url of ['/missing.png','/data/academy.sqlite','/.env.production.example','/assets/../server.mjs','/assets/%2e%2e/server.mjs','/assets/%2f..%2fserver.mjs','/assets/asset-prompts.md']){const response=await fetch(base+url);assert.equal(response.status,404,url);assert.ok(!response.headers.get('content-type').includes('html'))}
 assert.equal((await fetch(base+'/assets/music-line.svg',{method:'POST'})).status,405);
});
