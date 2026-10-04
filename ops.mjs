import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';import {backup,DatabaseSync} from 'node:sqlite';import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';import path from 'node:path';
const [command,...args]=process.argv.slice(2);
const error=text=>{throw Error(text)};
if(!process.env.DB_PATH||process.env.DB_PATH===':memory:')error('격리 작업 대상 DB_PATH를 명시하세요');
process.env.NODE_ENV='test';process.env.APP_MODE='production';
async function input(){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>10000)error('입력 길이 초과')}return JSON.parse(value)}
let api;
try{
 if(command==='restore'){
  const [encrypted]=args,target=path.resolve(process.env.DB_PATH),journal=process.env.RETENTION_JOURNAL_PATH;
  if(existsSync(target))error('복원 대상은 존재하지 않는 새 격리 DB여야 합니다');
  if(!journal||!existsSync(journal)||path.resolve(journal)===target)error('최신 별도 삭제 목록 RETENTION_JOURNAL_PATH가 필요합니다');
  const {key}=await input();if(!/^[a-f0-9]{64}$/.test(key||''))error('32바이트 hex 백업 키 필요');
  const data=readFileSync(encrypted);if(data.length<35||data.subarray(0,7).toString()!=='PDMBAK1')error('백업 형식 오류');
  const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),data.subarray(7,19));decipher.setAuthTag(data.subarray(19,35));
  const payload=JSON.parse(Buffer.concat([decipher.update(data.subarray(35)),decipher.final()]).toString());
  const control=new DatabaseSync(journal,{readOnly:true});try{if(!control.prepare('SELECT 1 FROM datasets WHERE dataset=?').get(payload.dataset))error('삭제 목록의 데이터셋 불일치')}finally{control.close()}
  writeFileSync(target,Buffer.from(payload.database,'base64'),{flag:'wx',mode:0o600});
  api=await import('./server.mjs');api.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('restore_state','pending');
  const dataset=api.db.prepare('SELECT value FROM metadata WHERE key=?').get('dataset').value;
  if(dataset!==payload.dataset)error('백업 데이터셋 불일치');
  const count=api.db.prepare('SELECT count(*) n FROM deletion_journal.entries WHERE dataset=?').get(dataset).n;if(count<payload.deletions)error('삭제 목록이 백업 시점보다 오래되었습니다');
  const applied=api.applyDeletionJournal();api.sweep();const check=api.inspectIntegrity();if(!check.ok)error('복원 관계/무결성 검사 실패');
  api.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('restore_state','verified');
  console.log(JSON.stringify({ok:true,removed:applied.removed,integrity:true,auth_revoked:true,external_copies:'미검수',resume:'실제 운영 전 검수 필요'}));
 }else{
  if(!existsSync(process.env.DB_PATH)&&command!=='init-director')error('대상 DB 없음');
  api=await import('./server.mjs');
  if(command==='backup'){
   const [target]=args;if(!target||existsSync(target))error('새 백업 파일 경로 필요');const {key}=await input();if(!/^[a-f0-9]{64}$/.test(key||''))error('32바이트 hex 백업 키 필요');
   const scratch=path.resolve(target)+'.scratch-'+randomBytes(8).toString('hex');
   try{await backup(api.db,scratch);const dataset=api.db.prepare('SELECT value FROM metadata WHERE key=?').get('dataset').value;
    const payload=JSON.stringify({database:readFileSync(scratch).toString('base64'),at:new Date().toISOString(),dataset,deletions:api.db.prepare('SELECT count(*) n FROM deletion_journal.entries WHERE dataset=?').get(dataset).n});
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),nonce);const encrypted=Buffer.concat([cipher.update(payload),cipher.final()]);writeFileSync(target,Buffer.concat([Buffer.from('PDMBAK1'),nonce,cipher.getAuthTag(),encrypted]),{flag:'wx',mode:0o600});console.log(JSON.stringify({ok:true,encrypted:true,deletion_journal_backed_up:false,notice:'삭제 목록은 별도 최신 사본으로 관리하고 키는 백업과 분리하세요'}));
   }finally{if(existsSync(scratch))unlinkSync(scratch)}
  }else if(command==='check')console.log(JSON.stringify(api.inspectIntegrity()));
  else if(command==='purge'){api.sweep();console.log(JSON.stringify({ok:true,db_only:true,external_copies:'미검수'}))}
  else if(command==='init-director'){const {id,password}=await input();console.log(JSON.stringify(api.initializeDirector(id,password)))}
  else if(command==='recover-director'){const {id,password,method}=await input();console.log(JSON.stringify(api.recoverDirector(id,password,method)))}
  else if(command==='preview-import'){const {previewImport}=await import('./importer.mjs');console.log(JSON.stringify(previewImport(api.db,JSON.parse(readFileSync(args[0],'utf8'))),null,2))}
  else if(command==='apply-import'){console.log(JSON.stringify(api.importBatch(JSON.parse(readFileSync(args[0],'utf8')))))}
  else if(command==='rollback-import')console.log(JSON.stringify(api.undoImport(args[0])));
  else if(command==='begin-operation'){
   const review=JSON.parse(readFileSync(args[0],'utf8'));for(const field of ['policy_review','privacy_review','migration_review','restore_review','director_review','deployment_review'])if(review[field]?.approved!==true||typeof review[field]?.evidence!=='string'||!review[field].evidence.trim())error(field+' 검수 증적 필요');
   if(!api.inspectIntegrity().ok)error('무결성 검사 실패');if(api.db.prepare("SELECT 1 FROM accounts WHERE id='director-demo'").get()||!api.db.prepare('SELECT 1 FROM accounts WHERE student IS NULL AND enabled=1').get())error('실제 원장 계정 설정 필요');
   api.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('lifecycle','operating');console.log(JSON.stringify({ok:true,import_locked:true}));
  }else error('지원 명령: backup, restore, check, purge, init-director, recover-director, preview-import, apply-import, rollback-import, begin-operation');
 }
}catch(e){console.error('작업 실패: '+e.message);process.exitCode=1}finally{api?.db.close()}
