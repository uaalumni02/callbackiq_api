/** Additive internal alerting, never sends to customers. */
import RevenueRescueOpportunity from '../models/revenueRescueOpportunity.js';
import RevenueAutomationSettings from '../models/revenueAutomationSettings.js';
import Alert from '../models/alert.js';
import Business from '../models/business.js';
const ACTIVE=['open','claimed','contacted'];
export async function scanRevenueRescueDeadlines({now=new Date(),limit=25}={}){
  const rows=await RevenueRescueOpportunity.find({status:{$in:ACTIVE},dueAt:{$lte:now,$ne:null}})
    .sort({dueAt:1}).limit(Math.max(1,Math.min(100,limit))).lean();
  let created=0;
  for(const row of rows){
    const [business,settings]=await Promise.all([Business.findById(row.business).select('isActive').lean(),RevenueAutomationSettings.findOne({business:row.business}).select('enabled').lean()]);
    if(!business?.isActive||!settings?.enabled)continue;
    const dedupeKey=`revenue-rescue:${row._id}:${new Date(row.dueAt).getTime()}`;
    const r=await Alert.updateOne({business:row.business,dedupeKey},{$setOnInsert:{business:row.business,
      dedupeKey,lead:row.lead||null,appointment:row.appointment||null,type:'unanswered_hot_lead',
      channel:'in_app',title:'Revenue opportunity needs follow-up',
      message:'An assigned or unclaimed recovery opportunity passed its follow-up deadline.',
      status:'sent',priority:'high',actionRequired:true,dueAt:row.dueAt,sentAt:now,
      metadata:{revenueRescueOpportunityId:String(row._id)}}},{upsert:true});
    if(r.upsertedCount)created++;
  }
  return {scanned:rows.length,created};
}
