// Synchronous local simulator. A real provider must implement send/query with
// its authenticated API, receipt semantics and recovery strategy separately.
export function createMockSmsProvider({db,nowMs}) {
 return {
  mode:'mock',externalCalls:0,
  send({key,to,text,outcome='전달 성공'}) {
   if(!/^0\d{8,10}$/.test(to)||typeof text!=='string'||!text.trim()||text.length>1000)throw Error('모의 문자 입력 오류');
   const old=db.prepare('SELECT * FROM op_mock_receipts WHERE id=?').get(key);
   if(old)return {id:key,status:old.status,replayed:true};
   db.prepare('INSERT INTO op_mock_receipts(id,status,at) VALUES(?,?,?)').run(key,outcome,nowMs());
   return {id:key,status:outcome,replayed:false};
  },
  query(key){const r=db.prepare('SELECT * FROM op_mock_receipts WHERE id=?').get(key);return r?{id:r.id,status:r.status,at:r.at}:null}
 };
}
