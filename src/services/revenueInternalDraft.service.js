/** Prepares a reviewable draft, never schedules or sends a message. */
import RevenueAutomationCampaign from '../models/revenueAutomationCampaign.js';
const TEMPLATES={
 estimate:'Hello {{customerName}}, following up on your {{title}} estimate. Would you like to discuss it with our team?',
 invoice:'Hello {{customerName}}, we are following up regarding your outstanding invoice for {{title}}. Please contact our office with any questions. {{paymentUrl}}',
};
export async function prepareInternalRecoveryDraft(record){
 const purpose=record.recordType==='estimate'?'estimate_followup':record.recordType==='invoice'?'invoice_reminder':null;
 if(!purpose||!record.opportunity||!/^\+1\d{10}$/.test(record.customerPhone))return {skipped:true};
 if(!(['sent','awaiting_customer'].includes(record.status)&&record.recordType==='estimate') && !(record.status==='issued'&&record.recordType==='invoice'))return {skipped:true};
 return RevenueAutomationCampaign.updateOne({business:record.business,opportunity:record.opportunity,purpose},{$setOnInsert:{
  business:record.business,opportunity:record.opportunity,record:record._id,phone:record.customerPhone,
  purpose,template:TEMPLATES[record.recordType],state:'draft',executeAt:new Date(Date.now()+24*3600_000),
  history:[{at:new Date(),status:'draft',reason:'Internal record is eligible for owner review, not auto-approved'}]
 }},{upsert:true});
}
