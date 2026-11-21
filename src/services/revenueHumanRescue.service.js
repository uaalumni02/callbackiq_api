import { enabledBusinessIds } from './businessFeatureAccess.service.js';
import { isBusinessFeatureEnabled } from '../helpers/businessFeatures.js';
import { revenueHumanRescueScanRevenueRescueDeadlinesAlertUpdateOne } from './stateTransitions/reviews.js';
/** Additive internal alerting, never sends to customers. */
import RevenueRescueOpportunity from '../models/revenueRescueOpportunity.js';
import RevenueAutomationSettings from '../models/revenueAutomationSettings.js';
import Alert from '../models/alert.js';
import Business from '../models/business.js';
const ACTIVE=['open','claimed','contacted'];
export async function scanRevenueRescueDeadlines({now=new Date(),limit=25}={}){
  const businessIds = await enabledBusinessIds("revenueRescueEnabled");
  const rows=await RevenueRescueOpportunity.find({business:{$in:businessIds},status:{$in:ACTIVE},dueAt:{$lte:now,$ne:null}})
    .sort({dueAt:1}).limit(Math.max(1,Math.min(100,limit))).lean();
  let created=0;
  for(const row of rows){
    const [business,settings]=await Promise.all([Business.findById(row.business).select('isActive features').lean(),RevenueAutomationSettings.findOne({business:row.business}).select('enabled').lean()]);
    if(!business?.isActive||!settings?.enabled||!isBusinessFeatureEnabled(business,"revenueRescueEnabled"))continue;
    const dedupeKey=`revenue-rescue:${row._id}:${new Date(row.dueAt).getTime()}`;
    const r=await revenueHumanRescueScanRevenueRescueDeadlinesAlertUpdateOne({ Alert, dedupeKey, now, row });
    if(r.upsertedCount)created++;
  }
  return {scanned:rows.length,created};
}
