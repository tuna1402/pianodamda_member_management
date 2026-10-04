const DAY=86400000;
const statuses=['발송 대기','보류','처리 중','업체 접수','전달 성공','전달 실패','결과 확인 중','발송 전 취소'];
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const dateAt=value=>new Date(value).toISOString().slice(0,10);

// Read all chart series in one database snapshot; never return personal fields.
export function statistics(db,{anchor,period='7d',now=Date.now()}){
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date(now));
 anchor??=today;
 if(!validDate(anchor)||!['7d','28d'].includes(period)){const error=Error('통계 기준 날짜와 조회 기간을 확인해 주세요');error.status=400;throw error}
 const days=period==='7d'?7:28,group=period==='7d'?1:7,end=Date.parse(anchor),start=end-(days-1)*DAY,from=dateAt(start);
 db.exec('BEGIN');
 try{
  const events=db.prepare("SELECT json_extract(data,'$.date') date,json_extract(data,'$.kind') kind,count(*) count FROM op_calendar WHERE json_extract(data,'$.status')='확정' AND json_extract(data,'$.kind') IN ('상담','체험','수업') AND json_extract(data,'$.date')>=? AND json_extract(data,'$.date')<=? GROUP BY date,kind").all(from,anchor);
  const lessons=db.prepare("SELECT json_extract(data,'$.date') date,count(*) count FROM records WHERE kind='lessons' AND json_extract(data,'$.status')='완료' AND json_extract(data,'$.date')>=? AND json_extract(data,'$.date')<=? GROUP BY date").all(from,anchor);
  const buckets=Array.from({length:days/group},(_,i)=>({from:dateAt(start+i*group*DAY),to:dateAt(start+(i*group+group-1)*DAY),classes:0,consultations:0,trials:0,completed:0,total:0}));
  const keys={수업:'classes',상담:'consultations',체험:'trials'};
  for(const row of events){const bucket=buckets[Math.floor((Date.parse(row.date)-start)/DAY/group)];bucket[keys[row.kind]]+=row.count;bucket.total+=row.count}
  for(const row of lessons)buckets[Math.floor((Date.parse(row.date)-start)/DAY/group)].completed+=row.count;
  const totals={classes:0,consultations:0,trials:0,confirmed:0,completed:0};
  for(const bucket of buckets){for(const name of ['classes','consultations','trials','completed'])totals[name]+=bucket[name];totals.confirmed+=bucket.total}
  const counts=db.prepare('SELECT status,count(*) count FROM op_alerts GROUP BY status').all();
  const alerts={scope:'전체 현재 상태',total:0,attention:0,items:statuses.map(status=>({status,count:0}))};
  for(const row of counts){let item=alerts.items.find(item=>item.status===row.status);if(!item){item={status:'기타 · 확인 필요',count:0};if(!alerts.items.some(item=>item.status=== '기타 · 확인 필요'))alerts.items.push(item);else item=alerts.items.at(-1)}item.count+=row.count;alerts.total+=row.count;if(['보류','전달 실패','결과 확인 중'].includes(row.status)||!statuses.includes(row.status))alerts.attention+=row.count}
  const todayConfirmed=db.prepare("SELECT count(*) count FROM op_calendar WHERE json_extract(data,'$.date')=? AND json_extract(data,'$.status')='확정' AND json_extract(data,'$.kind') IN ('상담','체험','수업')").get(today).count;
  db.exec('COMMIT');
  return {timezone:'Asia/Seoul',anchor,from,to:anchor,period,bucket_days:group,today,updated_at:new Date(now).toISOString(),mode:'mock',definitions_version:1,totals:{...totals,today_confirmed:todayConfirmed},buckets,alerts};
 }catch(error){db.exec('ROLLBACK');throw error}
}
