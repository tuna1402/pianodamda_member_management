import {isIP} from 'node:net';

export function runtimeConfig(env=process.env){
 const host=env.HOST??'127.0.0.1',port=Number(env.PORT??4173),grace=Number(env.SHUTDOWN_GRACE_MS??10000);
 if(host!=='localhost'&&!isIP(host))throw Error('HOST must be localhost or an explicit IP address');
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT must be an integer between 0 and 65535');
 if(!Number.isInteger(grace)||grace<1000||grace>60000)throw Error('SHUTDOWN_GRACE_MS must be between 1000 and 60000');
 return {host,port,grace};
}

export function createServiceRuntime({server,db,workers,now=Date.now,grace=10000,log=()=>{}}){
 const started=now(),states=Object.fromEntries(Object.entries(workers).map(([name,worker])=>[name,{interval_ms:worker.interval,last_attempt_at:null,last_success_at:null,consecutive_failures:0,running:false}]));
 const timers=[],running=new Set(),responses=new Set();let active=false,stopping=false,closed=false,shutdownPromise=null;
 server.on('request',(req,res)=>{if(res.writableEnded)return;responses.add(res);res.once('finish',()=>{responses.delete(res);if(stopping)req.socket.end()});res.once('close',()=>responses.delete(res))});
 function workerState(name){const s=states[name];if(stopping)return 'stopped';if(!active||s.last_success_at===null)return s.consecutive_failures?'failed':'pending';if(s.consecutive_failures)return 'failed';return now()-s.last_success_at>3*s.interval_ms?'stale':'healthy'}
 function snapshot(){let database=false;if(!closed)try{db.prepare('SELECT 1').get();database=true}catch{};const healthy=active&&Object.keys(states).every(name=>workerState(name)==='healthy');return {ready:server.listening&&!stopping&&database&&healthy,stopping,database,workers:healthy,started_at:new Date(started).toISOString(),jobs:Object.fromEntries(Object.entries(states).map(([name,s])=>[name,{...s,last_attempt_at:s.last_attempt_at===null?null:new Date(s.last_attempt_at).toISOString(),last_success_at:s.last_success_at===null?null:new Date(s.last_success_at).toISOString(),state:workerState(name)}]))}}
 function publicHealth(readiness=false){const s=snapshot();return readiness?{status:s.ready?'ready':'not_ready',checks:{database:s.database,workers:s.workers}}:{status:stopping?'stopping':'ok'}}
 function run(name){const state=states[name];if(!active||stopping||state.running)return Promise.resolve({skipped:true});state.running=true;state.last_attempt_at=now();
  const job=Promise.resolve().then(()=>workers[name].run()).then(()=>{state.last_success_at=now();state.consecutive_failures=0;return {ok:true}},()=>{state.consecutive_failures++;log('worker-failed:'+name);return {ok:false}}).finally(()=>{state.running=false;running.delete(job)});
  running.add(job);return job;
 }
 function start(){if(active||stopping)return;active=true;for(const [name,worker]of Object.entries(workers)){run(name);const timer=setInterval(()=>run(name),worker.interval);timer.unref();timers.push(timer)}}
 function shutdown(){if(shutdownPromise)return shutdownPromise;stopping=true;for(const timer of timers)clearInterval(timer);active=false;for(const res of responses)if(!res.headersSent)res.setHeader('Connection','close');
  shutdownPromise=(async()=>{let forced=false;await new Promise((resolve,reject)=>{if(!server.listening)return resolve();const timeout=setTimeout(()=>{forced=true;server.closeAllConnections()},grace);timeout.unref();server.close(error=>{clearTimeout(timeout);if(error)reject(error);else resolve()});server.closeIdleConnections()});await Promise.all([...running]);if(!closed){db.close();closed=true}log(forced?'shutdown-forced':'shutdown-complete');return {forced}})();return shutdownPromise;
 }
 return {start,run,snapshot,publicHealth,shutdown,get stopping(){return stopping}};
}
