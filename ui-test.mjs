import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function client(fetch){
 const alert={textContent:'',focus(){this.focused=true}};
 const root={onclick:null,hidden:true,innerHTML:'',textContent:'',focus(){this.focused=true},setAttribute(){},querySelector(){return this}};
 const document={querySelector(){return root}};
 const context=vm.createContext({document,fetch,console,crypto});
 const source=readFileSync(new URL('./public/app.js',import.meta.url),'utf8').replace("api('me').then(d=>{me=d;render()}).catch(login);",'');
 vm.runInContext(source,context);
 vm.runInContext(readFileSync(new URL('./public/charts.js',import.meta.url),'utf8'),context);
 vm.runInContext(readFileSync(new URL('./public/operations-ui.js',import.meta.url),'utf8'),context);
 return {context,alert};
}
test('UI: malformed or lost response offers retry without treating save as success',async()=>{
 const {context}=client(async()=>({json:async()=>{throw Error('bad JSON')},ok:true}));
 await assert.rejects(vm.runInContext("api('admin/students',{name:'합성'})",context),/응답을 확인하지 못했습니다/);
 context.fetch=async()=>{throw Error('disconnected')};
 await assert.rejects(vm.runInContext("api('admin/students',{name:'합성'})",context),/입력을 유지한 채 다시 시도/);
});
test('UI: duplicate submission is locked; original disabled states recover after failure',async()=>{
 const {context,alert}=client(()=>{});let resolve,calls=0;
 const pending=new Promise(r=>resolve=r),buttons=[{disabled:false},{disabled:true}];
 const attrs={},form={dataset:{},querySelectorAll:()=>buttons,querySelector:()=>alert,setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k]};
 context.form=form;context.action=async()=>{calls++;await pending;throw Error('연결 실패')};
 const first=vm.runInContext('busy(form,action)',context);
 await vm.runInContext('busy(form,action)',context);
 assert.equal(calls,1);assert.equal(attrs['aria-busy'],'true');assert.deepEqual(buttons.map(b=>b.disabled),[true,true]);
 resolve();await first;assert.equal(alert.textContent,'연결 실패');assert.equal(alert.focused,true);assert.deepEqual(buttons.map(b=>b.disabled),[false,true]);assert.equal(attrs['aria-busy'],undefined);
});
test('UI: server conflict remains an error with its status for controlled handling',async()=>{
 const {context}=client(async()=>({ok:false,status:409,json:async()=>({error:'다른 화면에서 수정되었습니다'})}));
 await assert.rejects(vm.runInContext("api('admin/students/1',{version:1},'PUT')",context),e=>e.status===409&&e.message.includes('다른 화면'));
});
test('OP-T03 운영 대시보드 조회 실패는 0건으로 숨기지 않고 재조회 제공',async()=>{
 const {context}=client(async()=>{throw Error('연결 끊김')});
 await vm.runInContext("me={role:'director'};render()",context);
 const root=context.document.querySelector('#app');assert.match(root.innerHTML,/정보를 불러올 수 없습니다/);assert.match(root.innerHTML,/다시 시도/);assert.doesNotMatch(root.innerHTML,/class="metric/);assert.match(root.textContent,/연결이 끊겼습니다/);assert.equal(root.hidden,true);
});

const chartFixture=()=>({from:'2026-09-27',to:'2026-10-03',today:'2026-10-04',period:'7d',bucket_days:1,updated_at:'2026-10-03T15:00:00Z',totals:{today_confirmed:0,classes:3,consultations:1,trials:0,confirmed:4,completed:2},buckets:[{from:'2026-09-27',to:'2026-09-27',classes:3,consultations:1,trials:0,total:4,completed:2}],alerts:{total:2,attention:1,items:[{status:'보류',count:1},{status:'처리 중',count:1}]}});
test('통계 UI: 차트와 숫자 표는 같은 값, 건수 0·상태도 정보로 표시',()=>{
 const {context}=client(()=>{});context.fixture=chartFixture();
 const chart=vm.runInContext("statsChart(fixture,'confirmed')",context);assert.match(chart,/상담 1건/);assert.match(chart,/수업 3건/);assert.match(chart,/<td>4<\/td>/);assert.match(chart,/숫자 표로 보기/);assert.match(chart,/role="img"/);
 const graph=vm.runInContext('alertGraph(fixture)',context);assert.match(graph,/전체 현재 상태 2건/);assert.match(graph,/처리 중/);assert.match(graph,/보류 1건/);
 context.fixture.buckets[0]={...context.fixture.buckets[0],total:0,classes:0,consultations:0,trials:0,completed:0};context.fixture.totals.confirmed=0;
 const empty=vm.runInContext("statsChart(fixture,'confirmed')",context);assert.ok(!empty.includes('NaN'));assert.ok(!empty.includes('Infinity'));
});
test('통계 UI: 느린 이전 기간 응답이 마지막 선택 화면을 덮어쓰지 않음',async()=>{
 const {context}=client(()=>{});context.document.querySelectorAll=()=>[];
 vm.runInContext("opsShell=(title,body)=>{document.querySelector('#app').innerHTML=body};bindEventButtons=()=>{};bindRecordButtons=()=>{}",context);
 const dashboard={counts:{상담:0,체험:0,수업:0},registered:0,items:[],tasks:[],policy:{enabled:false},alerts:{next:null},changes:[]};
 let oldResolve;
 const older=new Promise(resolve=>oldResolve=resolve),fixture=chartFixture();
 context.fetch=async url=>({ok:true,json:async()=>url.includes('statistics')?(url.includes('7d')?await older:{...fixture,from:'2026-09-06',period:'28d'}):dashboard});
 const first=vm.runInContext("renderRevision=1;operationsPeriod='7d';operationsDashboard()",context);
 await vm.runInContext("renderRevision=2;operationsPeriod='28d';operationsDashboard()",context);
 assert.match(context.document.querySelector('#app').innerHTML,/2026-09-06/);
 oldResolve(fixture);await first;
 assert.match(context.document.querySelector('#app').innerHTML,/2026-09-06/);assert.match(context.document.querySelector('#app').innerHTML,/aria-pressed="true">최근 4주/);
});
test('인증 UI: 로그인으로 전환하면 이전 조회 응답과 로딩을 무효화',()=>{
 const {context}=client(()=>{});
 vm.runInContext("renderRevision=4;login()",context);
 assert.equal(vm.runInContext('renderRevision',context),5);assert.equal(context.document.querySelector('#loading').hidden,true);assert.match(context.document.querySelector('#app').innerHTML,/name="mode"/);
});
