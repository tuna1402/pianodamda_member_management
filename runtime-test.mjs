import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServiceRuntime,runtimeConfig} from './service-runtime.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(workers,clock=()=>Date.now(),handler=(req,res)=>res.end('ok'),grace=1000){const db=new DatabaseSync(':memory:'),server=http.createServer(handler),runtime=createServiceRuntime({server,db,workers,now:clock,grace});return {db,server,runtime}}

test('실행 설정: loopback 기본값·명시 HOST와 잘못된 설정 거부',()=>{
 assert.deepEqual(runtimeConfig({}),{host:'127.0.0.1',port:4173,grace:10000});
 assert.equal(runtimeConfig({HOST:'0.0.0.0',PORT:'10000'}).host,'0.0.0.0');assert.equal(runtimeConfig({HOST:'::1'}).host,'::1');
 for(const env of [{HOST:''},{HOST:'bad hostname'},{PORT:'-1'},{PORT:'1.5'},{PORT:'65536'},{SHUTDOWN_GRACE_MS:'0'}])assert.throws(()=>runtimeConfig(env));
});
test('실행 감시: 성공·실패·회복·지연을 readiness와 관리자 증적에 구분',async()=>{
 let now=0,fail=false;const {server,runtime}=fixture({alerts:{interval:10000,run:()=>{if(fail)throw Error('SECRET_KEY_SHOULD_NOT_LEAK')}}},()=>now);await listen(server);
 try{
  assert.equal(runtime.publicHealth(true).status,'not_ready');runtime.start();await runtime.run('alerts');await wait(0);
  assert.equal(runtime.publicHealth(true).status,'ready');assert.equal(runtime.snapshot().jobs.alerts.last_success_at,'1970-01-01T00:00:00.000Z');
  fail=true;now=100;await runtime.run('alerts');assert.equal(runtime.snapshot().jobs.alerts.state,'failed');assert.equal(runtime.publicHealth(true).status,'not_ready');assert.ok(!JSON.stringify(runtime.snapshot()).includes('SECRET'));
  fail=false;now=200;await runtime.run('alerts');assert.equal(runtime.publicHealth(true).status,'ready');assert.equal(runtime.snapshot().jobs.alerts.consecutive_failures,0);
  now=30201;assert.equal(runtime.snapshot().jobs.alerts.state,'stale');assert.equal(runtime.publicHealth(true).status,'not_ready');
  assert.deepEqual(Object.keys(runtime.publicHealth(true)),['status','checks']);
 }finally{await runtime.shutdown()}
});
test('실행 감시: 겹친 worker 호출 건너뜀·종료는 진행 중 작업 완료 후 DB 닫음',async()=>{
 let complete,calls=0;const pending=new Promise(resolve=>complete=resolve),{db,server,runtime}=fixture({alerts:{interval:10000,run:async()=>{calls++;await pending;db.exec('CREATE TABLE finished(id INTEGER)')}}});await listen(server);runtime.start();await wait(0);
 assert.deepEqual(await runtime.run('alerts'),{skipped:true});assert.equal(calls,1);const ending=runtime.shutdown();assert.equal(runtime.stopping,true);assert.equal(runtime.snapshot().jobs.alerts.state,'stopped');assert.equal(db.prepare('SELECT 1').get()['1'],1);
 complete();await ending;assert.throws(()=>db.prepare('SELECT 1'));assert.deepEqual(await runtime.run('alerts'),{skipped:true});assert.equal(calls,1);
});
test('실행 감시: timer가 자동 반복 실행하고 종료 후 추가 작업 없음',async()=>{
 let calls=0;const {server,runtime}=fixture({alerts:{interval:15,run:()=>{calls++}}});await listen(server);runtime.start();
 try{const deadline=Date.now()+1000;while(calls<3&&Date.now()<deadline)await wait(20);assert.ok(calls>=3,'automatic interval did not repeat');await runtime.shutdown();const stopped=calls;await wait(45);assert.equal(calls,stopped)}finally{await runtime.shutdown()}
});
test('정상 종료: 진행 요청 drain 후 DB 닫음·종료 중 readiness 실패·중복 종료 안전',async()=>{
 let requestStarted;const started=new Promise(resolve=>requestStarted=resolve),{db,server,runtime}=fixture({retention:{interval:60000,run:()=>{}}},Date.now,(req,res)=>{requestStarted();setTimeout(()=>{res.end(String(db.prepare('SELECT 7 value').get().value))},30)});await listen(server);runtime.start();await wait(0);
 const response=fetch('http://127.0.0.1:'+server.address().port);await started;const first=runtime.shutdown();assert.equal(runtime.publicHealth().status,'stopping');assert.equal(runtime.publicHealth(true).status,'not_ready');assert.equal(runtime.shutdown(),first);assert.equal(await(await response).text(),'7');assert.deepEqual(await first,{forced:false});assert.throws(()=>db.prepare('SELECT 1'));
});
test('종료 한도: 멈춘 HTTP 연결은 한도 뒤 닫고 DB 안전 종료',async()=>{
 let began;const opened=new Promise(resolve=>began=resolve),{db,server,runtime}=fixture({alerts:{interval:10000,run:()=>{}}},Date.now,()=>began());await listen(server);runtime.start();await wait(0);
 const response=fetch('http://127.0.0.1:'+server.address().port).then(()=>false,()=>true);await opened;assert.deepEqual(await runtime.shutdown(),{forced:true});assert.equal(await response,true);assert.throws(()=>db.prepare('SELECT 1'));
});

test('실제 Node 실행: HOST 바인딩·public health/readiness·원장 감시·신호 종료·재시작 보존',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'academy-runtime-')),database=path.join(dir,'demo.sqlite');
 const source=new URL('./server.mjs',import.meta.url).href;
 const script=path.join(dir,'runner.mjs');
 writeFileSync(script,`import {server,runtime} from ${JSON.stringify(source)};server.on('listening',()=>console.log('TEST_PORT:'+server.address().port));process.stdin.on('data',()=>{process.stdin.pause();process.emit('SIGTERM')});`);
 async function start(){const child=spawn(process.execPath,[script],{env:{...process.env,NODE_ENV:'development',APP_MODE:'development',DB_PATH:database,HOST:'0.0.0.0',PORT:'0',SHUTDOWN_GRACE_MS:'1000'},stdio:['pipe','pipe','pipe']});let output='';const port=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('startup timed out')),10000);child.stdout.on('data',chunk=>{output+=chunk;const match=/TEST_PORT:(\d+)/.exec(output);if(match){clearTimeout(timeout);resolve(match[1])}});child.on('error',reject);child.on('exit',code=>{if(!output.includes('TEST_PORT:')){clearTimeout(timeout);reject(Error('early exit '+code))}})});return {child,base:'http://127.0.0.1:'+port}}
 async function end(child){const exit=new Promise(resolve=>child.once('exit',resolve));if(process.platform==='win32')child.stdin.write('shutdown');else child.kill('SIGTERM');child.stdin.end();assert.equal(await exit,0)}
 let process1,process2;
 try{
  process1=await start();let health=await fetch(process1.base+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok'});
  const ready=await fetch(process1.base+'/readyz');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{status:'ready',checks:{database:true,workers:true}});
  assert.equal((await fetch(process1.base+'/healthz',{method:'POST'})).status,405);assert.equal(await(await fetch(process1.base+'/readyz',{method:'HEAD'})).text(),'');
  assert.equal((await fetch(process1.base+'/api/admin/runtime')).status,401);
  const login=await fetch(process1.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'director-demo',password:'Demo-Director-2026!',mode:'director'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const snapshot=await(await fetch(process1.base+'/api/admin/runtime',{headers:{Cookie:cookie}})).json();assert.equal(snapshot.ready,true);assert.ok(snapshot.jobs.alerts.last_success_at);assert.ok(snapshot.jobs.retention.last_success_at);assert.ok(!JSON.stringify(snapshot).includes(database));
  const pupil=await fetch(process1.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'MBR-000742',password:'1234',mode:'student'})});assert.equal(pupil.status,200);const pupilCookie=pupil.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(process1.base+'/api/admin/runtime',{headers:{Cookie:pupilCookie}})).status,403);
  const changed=await fetch(process1.base+'/api/password',{method:'POST',headers:{'Content-Type':'application/json',Cookie:pupilCookie},body:JSON.stringify({password:'Runtime-Student-2026!',confirm:'Runtime-Student-2026!'})});assert.equal(changed.status,200);assert.equal((await fetch(process1.base+'/api/admin/runtime',{headers:{Cookie:changed.headers.get('set-cookie').split(';')[0]}})).status,403);
  for(let i=0;i<6;i++){const forged=await fetch(process1.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.'+(i+1)},body:JSON.stringify({id:'synthetic-proxy-check',password:'wrong',mode:'director'})});assert.equal(forged.status,i===5?429:401)}
  await end(process1.child);process1=null;
  const saved=new DatabaseSync(database);assert.ok(saved.prepare('SELECT count(*) count FROM records').get().count>0);saved.exec("INSERT INTO metadata(key,value) VALUES('runtime_fixture','persisted')");saved.close();
  process2=await start();assert.equal((await fetch(process2.base+'/readyz')).status,200);await end(process2.child);process2=null;
  const restored=new DatabaseSync(database);assert.equal(restored.prepare("SELECT value FROM metadata WHERE key='runtime_fixture'").get().value,'persisted');restored.close();
 }finally{for(const item of [process1,process2])if(item){item.child.kill();await new Promise(resolve=>item.child.once('exit',resolve))}const resolved=path.resolve(dir);if(path.dirname(resolved)!==path.resolve(tmpdir())||!path.basename(resolved).startsWith('academy-runtime-'))throw Error('Unsafe temporary cleanup path');rmSync(resolved,{recursive:true,force:true})}
});
