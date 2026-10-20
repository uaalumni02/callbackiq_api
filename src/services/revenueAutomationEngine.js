/** Recovery transport is opt-in and fail-closed. Uses MeekCall's existing SMS gateway. */
import crypto from 'node:crypto';
import RevenueAutomationCampaign from '../models/revenueAutomationCampaign.js';
import RevenueAutomationAttempt from '../models/revenueAutomationAttempt.js';
import RevenueAutomationConsent from '../models/revenueAutomationConsent.js';
import RevenueAutomationSettings from '../models/revenueAutomationSettings.js';
import RevenueRescueOpportunity from '../models/revenueRescueOpportunity.js';
import InternalRevenueRecord from '../models/internalRevenueRecord.js';
import ContactPreference from '../models/contactPreference.js';
import Business from '../models/business.js';
import Lead from '../models/lead.js';
import Appointment from '../models/appointment.js';
import Message from '../models/message.js';
import {sendSms} from './twilioSmsService.js';
import {contactGate,renderTemplate} from './revenueAutomationPolicy.js';
const liveEnabled=()=>process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED==='true';
const lockId=`revenue:${process.pid}:${crypto.randomBytes(5).toString('hex')}`;
const append=(status,reason)=>({at:new Date(),status,reason});
export async function recoverStaleRevenueLocks(now=new Date()){
  if(!liveEnabled())return 0;
  // Do not automatically retry a send with an uncertain provider outcome.
  const r=await RevenueAutomationCampaign.updateMany({state:'processing',lockUntil:{$lt:now}},
    {$set:{state:'uncertain',lockUntil:null,lockedBy:'',lastStatus:'Expired provider lock; manual reconciliation required'},
     $push:{history:{$each:[append('uncertain','stale_lock')],$slice:-100}}});
  return r.modifiedCount;
}
async function markCampaign(campaign,state,reason,extra={}){
 await RevenueAutomationCampaign.updateOne({_id:campaign._id,business:campaign.business,state:'processing',lockedBy:lockId},
 {$set:{state,lockUntil:null,lockedBy:'',lastStatus:reason,...extra},$push:{history:{$each:[append(state,reason)],$slice:-100}}});
}
export async function processOneRevenueCampaign({now=new Date(),transport=sendSms}={}){
 if(!liveEnabled())return null;
 const campaign=await RevenueAutomationCampaign.findOneAndUpdate({state:'scheduled',executeAt:{$lte:now},$or:[{lockUntil:null},{lockUntil:{$lte:now}}]},
  {$set:{state:'processing',lockedBy:lockId,lockUntil:new Date(+now+5*60*1000)},$inc:{revision:1}},
  {sort:{executeAt:1,_id:1},returnDocument:'after'});
 if(!campaign)return null;
 const {business:businessId}=campaign;
 try{
  const [business,opportunity,record,settings,grant,preference] = await Promise.all([
   Business.findById(businessId).lean(),
   RevenueRescueOpportunity.findOne({_id:campaign.opportunity,business:businessId}).lean(),
   campaign.record?InternalRevenueRecord.findOne({_id:campaign.record,business:businessId}).lean():null,
   RevenueAutomationSettings.findOne({business:businessId}).lean(),
   RevenueAutomationConsent.findOne({business:businessId,phone:campaign.phone,purpose:campaign.purpose}).lean(),
   ContactPreference.findOne({business:businessId,phone:campaign.phone}).lean(),
  ]);
  const [lead,appointment]=await Promise.all([opportunity?.lead?Lead.findOne({_id:opportunity.lead,business:businessId}).lean():null,opportunity?.appointment?Appointment.findOne({_id:opportunity.appointment,business:businessId}).lean():null]);
  const reason=contactGate({business,opportunity,record,lead,appointment,settings,grant,preference,campaign,now,envEnabled:liveEnabled()});
  if(reason){
   if(reason==='quiet_hours'){
    await markCampaign(campaign,'scheduled',reason,{executeAt:new Date(+now+60*60*1000)});
   } else await markCampaign(campaign,['customer_opted_out','opportunity_closed','underlying_record_closed','customer_changed','send_limit_reached','permission_expired'].includes(reason)?'suppressed':'paused',reason);
   return {status:'not_sent',reason};
  }
  const since=new Date(+now-24*60*60*1000);
  const recent=await RevenueAutomationAttempt.countDocuments({business:businessId,status:{$in:['provider_accepted','delivered','delivery_failed']},sentAt:{$gte:since}});
  if(recent>=settings.maxMessagesPerDay){
   await markCampaign(campaign,'scheduled','daily_limit',{executeAt:new Date(+now+60*60*1000)});
   return {status:'not_sent',reason:'daily_limit'};
  }
  const sequence=campaign.sentCount+1;
  const operationKey=`revenue:${businessId}:${campaign._id}:${sequence}`;
  const prev=await RevenueAutomationAttempt.findOne({business:businessId,operationKey});
  if(prev){await markCampaign(campaign,'uncertain','attempt_already_exists');return {status:'uncertain'};}
  const body=renderTemplate(campaign.template,{
   customerName:opportunity.customerName,title:opportunity.title,
   amountCents:record?.amountCents??opportunity.estimatedCents,
   paymentUrl:record?.paymentUrl||''
  });
  if(!body||body.length>700)throw new Error('Invalid message template');
  const attempt=await RevenueAutomationAttempt.create({business:businessId,campaign:campaign._id,sequence,operationKey,status:'reserved'});
  // Once a durable attempt is created, never automatically reissue if the outcome is ambiguous.
  try{
    const latestGrant=await RevenueAutomationConsent.findOne({business:businessId,phone:campaign.phone,purpose:campaign.purpose}).lean();
    const latestPreference=await ContactPreference.findOne({business:businessId,phone:campaign.phone}).lean();
    const latestOpportunity=await RevenueRescueOpportunity.findOne({_id:campaign.opportunity,business:businessId}).lean();
    const latestRecord=campaign.record?await InternalRevenueRecord.findOne({_id:campaign.record,business:businessId}).lean():null;
    const [latestLead,latestAppointment]=await Promise.all([latestOpportunity?.lead?Lead.findOne({_id:latestOpportunity.lead,business:businessId}).lean():null,latestOpportunity?.appointment?Appointment.findOne({_id:latestOpportunity.appointment,business:businessId}).lean():null]);
    const secondCheck=contactGate({business,opportunity:latestOpportunity,record:latestRecord,lead:latestLead,appointment:latestAppointment,settings,grant:latestGrant,preference:latestPreference,campaign,now:new Date(),envEnabled:liveEnabled()});
    if(secondCheck){
      await RevenueAutomationAttempt.updateOne({_id:attempt._id},{$set:{status:'suppressed',failureReason:secondCheck}});
      await markCampaign(campaign,'suppressed',secondCheck);
      return {status:'suppressed',reason:secondCheck};
    }
    const result=await transport({
     businessId, business, from:business.phone, to:campaign.phone, body,
     actorType:'automation',source:'revenue_recovery',usageCategory:'automation',
     requireOptOutDisclosure:true,allowOptedOut:false,bypassQuietHours:false,
     leadId:opportunity.lead||null,
     metadata:{idempotencyKey:operationKey,revenueCampaignId:String(campaign._id),revenueAttemptId:String(attempt._id)}
    });
    if(result?.suppressed){
      await RevenueAutomationAttempt.updateOne({_id:attempt._id},{$set:{status:'suppressed',failureReason:String(result.reason||'suppressed').slice(0,240)}});
      await markCampaign(campaign,result.policyBlocked?'scheduled':'suppressed',String(result.reason||'suppressed'),result.policyBlocked?{executeAt:new Date(+now+60*60*1000)}:{});
      return {status:'suppressed',reason:result.reason};
    }
    if(!result?.sid)throw new Error('Provider acceptance could not be confirmed');
    await RevenueAutomationAttempt.updateOne({_id:attempt._id},{$set:{status:'provider_accepted',providerMessageId:result.sid,sentAt:new Date()}});
    const more=sequence<campaign.maxSends;
    await markCampaign(campaign,more?'scheduled':'completed','provider_accepted',{
      sentCount:sequence,executeAt:more?new Date(+now+campaign.intervalHours*3600_000):campaign.executeAt
    });
    return {status:'provider_accepted'};
  }catch(error){
    await RevenueAutomationAttempt.updateOne({_id:attempt._id},{$set:{status:'uncertain',failureReason:String(error?.code||'provider_uncertain').slice(0,240)}});
    await markCampaign(campaign,'uncertain','provider_outcome_requires_review');
    return {status:'uncertain'};
  }
 }catch(error){
  await markCampaign(campaign,'failed',String(error?.code||'validation_error').slice(0,120));
  return {status:'failed'};
 }
}
export async function reconcileRevenueDelivery(limit=30){
 if(!liveEnabled())return 0;
 const attempts=await RevenueAutomationAttempt.find({status:'provider_accepted',providerMessageId:{$nin:['',null]}}).sort({createdAt:-1}).limit(limit).lean();
 let changed=0;
 for(const attempt of attempts){
  const msg=await Message.findOne({business:attempt.business,providerMessageId:attempt.providerMessageId}).select('status').lean();
  if(!msg)continue;
  const state=String(msg.status||'').toLowerCase();
  const translated=['delivered'].includes(state)?'delivered':['failed','undelivered'].includes(state)?'delivery_failed':null;
  if(translated){const r=await RevenueAutomationAttempt.updateOne({_id:attempt._id,status:'provider_accepted'},{$set:{status:translated,reconciledAt:new Date()}});changed+=r.modifiedCount;}
 }
 return changed;
}
export async function runDueRevenueCampaigns(limit=5){
 if(!liveEnabled())return {disabled:true,processed:0};
 await recoverStaleRevenueLocks();
 let processed=0;
 for(let i=0;i<Math.max(1,Math.min(10,limit));i++){
  const result=await processOneRevenueCampaign();if(!result)break;processed++;
 }
 await reconcileRevenueDelivery();
 return {processed};
}
