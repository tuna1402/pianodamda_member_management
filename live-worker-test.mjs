import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.DB_PATH=':memory:';
const {server,db,operations,setTestClock}=await import('./server.mjs');
test('실시간 자동 실행: 예약 시각 전 미접수·시각 도래 후 모의 접수 1회', {timeout:75000}, async()=>{
 setTestClock(null);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let cookie='',timer;
 const call=async(p,b,m=b?'POST':'GET')=>{const r=await fetch(base+'/api/'+p,{method:m,headers:{'Content-Type':'application/json',Cookie:cookie},body:b?JSON.stringify(b):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d};
 try{
  await call('login',{id:'director-demo',password:'Demo-Director-2026!',mode:'director'});let [s]=await call('admin/students');const [e]=await call('admin/enrollments');await call('admin/students/'+s.id,{...s,contact:'01000000001',operation_id:crypto.randomUUID()},'PUT');
  const p=await call('admin/alert-policy');delete p.mode;delete p.provider_ready;await call('admin/alert-policy',{...p,enabled:true,minutes_before:1,operation_id:crypto.randomUUID()},'PUT');
  const start=Math.floor(Date.now()/60000)*60000+120000,kst=new Date(start+9*3600000).toISOString();
  await call('admin/calendar',{operation_id:crypto.randomUUID(),kind:'수업',status:'확정',student:s.id,visitor:null,enrollment:e.id,date:kst.slice(0,10),time:kst.slice(11,16),duration:50,reminder:true,recipient:'본인',recipient_confirmed:true,type:'정규',room:'',reason:'',result:''});
  assert.equal(db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,0);
  await new Promise((resolve,reject)=>{const limit=Date.now()+70000;timer=setInterval(()=>{try{operations.runAlerts();const receipts=db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n;if(receipts){assert.ok(Date.now()>=start-60000);clearInterval(timer);resolve()}else if(Date.now()>limit){clearInterval(timer);reject(Error('예약 시각 자동 실행 시간 초과'))}}catch(e){clearInterval(timer);reject(e)}},100)});
  assert.equal(operations.runAlerts().sent,0);assert.equal(db.prepare('SELECT count(*) n FROM op_mock_receipts').get().n,1);assert.equal(db.prepare('SELECT status FROM op_alerts').get().status,'전달 성공');
 }finally{clearInterval(timer);server.close();db.close()}
});
