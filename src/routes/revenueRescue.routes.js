import requireBusinessFeature from '../middleware/require-business-feature.js';
/** Revenue Rescue V1: owner-scoped operational inbox. No SMS/voice/payment execution. */
import express from 'express';
import mongoose from 'mongoose';
import checkAuth from '../middleware/check-auth.js';
import checkSubscription from '../middleware/check-subscription.js';
import getOwnedBusiness from '../services/businessScope.service.js';
import RevenueRescueOpportunity from '../models/revenueRescueOpportunity.js';
import ConversionEvent from '../models/conversionEvent.js';
import Lead from '../models/lead.js';
import Appointment from '../models/appointment.js';
import {
  OPPORTUNITY_TYPES, STATUSES, assertTransition, moneyToCents,
  cleanString, validDueAt, normalizeType, suggestedAction
} from '../services/revenueRescuePolicy.js';

const router = express.Router();
router.use(checkAuth, checkSubscription, requireBusinessFeature('revenueRescueEnabled'));
const wrap = fn => (req,res,next)=> Promise.resolve().then(()=>fn(req,res)).catch(next);
const bad = (message, statusCode=400) => {const e=new Error(message);e.statusCode=statusCode;return e;};
const str = (x,n=160) => cleanString(x,n);
const actor = req => String(req.user?.userId || 'unknown');
const scoped = async req => {
  const business = await getOwnedBusiness({
    user:req.user, requestedBusinessId:req.query.businessId || req.body?.businessId
  });
  return business._id;
};
const objectId = value => {
  if (!mongoose.isObjectIdOrHexString(value)) throw bad('Invalid opportunity ID');
  return value;
};
const view = obj => {
  const x = obj.toObject ? obj.toObject() : obj;
  return {...x, suggestedAction:suggestedAction(x)};
};
function fromInput(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Expected opportunity object');
  const type = normalizeType(item.type);
  const title=str(item.title,200);
  if (!title) throw bad('Opportunity title is required');
  const externalKey=str(item.externalKey,160) || null;
  if (item.lead && !mongoose.isObjectIdOrHexString(item.lead)) throw bad('Invalid linked lead');
  if (item.appointment && !mongoose.isObjectIdOrHexString(item.appointment)) throw bad('Invalid linked appointment');
  return {
    type, title, externalKey, sourceSystem:'manual',
    customerName:str(item.customerName,180),phone:str(item.phone,40),
    details:str(item.details,1500), assignee:str(item.assignee,140),
    dueAt:validDueAt(item.dueAt), estimatedCents:moneyToCents(item.estimatedDollars,'estimatedDollars'),
    lead:item.lead||null, appointment:item.appointment||null,
    // Never infer consent from a file import or an admin-created record.
    contactPermission:'unknown'
  };
}
const getOpp = async (business,id) => {
  const found = await RevenueRescueOpportunity.findOne({business,_id:objectId(id)});
  if (!found) throw bad('Recovery opportunity not found',404);
  return found;
};

router.get('/catalog',wrap(async (req,res)=>{
  await scoped(req);
  res.json({success:true,data:{types:OPPORTUNITY_TYPES,statuses:STATUSES,outboundAutomationEnabled:false}});
}));
router.get('/opportunities',wrap(async (req,res)=>{
  const business=await scoped(req);
  const limit=Math.max(1,Math.min(Number(req.query.limit)||50,100));
  const query={business};
  if (req.query.type) query.type=normalizeType(req.query.type);
  if (req.query.status) {if(!STATUSES.includes(req.query.status))throw bad('Invalid status');query.status=req.query.status;}
  if (req.query.due === 'true') query.dueAt={$lte:new Date(),$ne:null};
  const rows=await RevenueRescueOpportunity.find(query).sort({updatedAt:-1,_id:-1}).limit(limit).lean();
  res.setHeader('Cache-Control','private, no-store');
  res.json({success:true,data:rows.map(view)});
}));
router.get('/summary',wrap(async (req,res)=>{
  const business=await scoped(req);
  const rows=await RevenueRescueOpportunity.aggregate([
    {$match:{business:new mongoose.Types.ObjectId(String(business))}},
    {$group:{_id:'$status',count:{$sum:1},estimatedCents:{$sum:{$ifNull:['$estimatedCents',0]}},
     bookedCents:{$sum:{$ifNull:['$bookedCents',0]}},
     paymentRecordedCents:{$sum:{$ifNull:['$paymentRecordedCents',0]}}}}
  ]);
  const totals=rows.reduce((acc,r)=>{
    acc.count+=r.count;acc.estimatedCents+=r.estimatedCents;acc.bookedCents+=r.bookedCents;
    acc.paymentRecordedCents+=r.paymentRecordedCents;acc.byStatus[r._id]=r.count;return acc;
  },{count:0,estimatedCents:0,bookedCents:0,paymentRecordedCents:0,byStatus:{}});
  res.json({success:true,data:{...totals,important:'Payment recorded is owner-reported unless provider evidence is independently confirmed.'}});
}));
router.get('/opportunities/:id',wrap(async(req,res)=>{
  const business=await scoped(req);
  res.json({success:true,data:view(await getOpp(business,req.params.id))});
}));
router.post('/opportunities',wrap(async (req,res)=>{
  const business=await scoped(req);
  const fields=fromInput(req.body);
  if (fields.lead) {const exists=await Lead.exists({_id:fields.lead,business});if(!exists)throw bad('Linked lead not found in this business',404);}
  if (fields.appointment) {const exists=await Appointment.exists({_id:fields.appointment,business});if(!exists)throw bad('Linked appointment not found in this business',404);}
  const history={at:new Date(),action:'created',actor:actor(req),fromStatus:'',toStatus:'open',note:'Created for staff review'};
  let doc;
  try {doc=await RevenueRescueOpportunity.create({...fields,business,status:'open',history:[history]});}
  catch(e){if(e.code===11000)throw bad('This imported opportunity already exists',409);throw e;}
  res.status(201).json({success:true,data:view(doc)});
}));
router.post('/import',wrap(async(req,res)=>{
  const business=await scoped(req);
  const rows=req.body?.rows;
  if(!Array.isArray(rows)||rows.length<1||rows.length>50)throw bad('Import requires 1-50 opportunity rows');
  // Validate the ENTIRE batch before any writes. Partial successes are reported.
  const clean=rows.map(fromInput);
  if(clean.some(x=>x.lead||x.appointment))throw bad('Linked ID imports are not supported; create them individually');
  const now=new Date();let created=0,duplicates=0;
  for(const r of clean){
    // Imported records need stable external keys to prevent repeated CSV uploads inflating opportunities.
    if(!r.externalKey) throw bad('Each imported row needs a stable externalKey');
  }
  for (const item of clean) {
    const existing=await RevenueRescueOpportunity.updateOne({business,type:item.type,externalKey:item.externalKey},
      {$setOnInsert:{...item,business,status:'open',history:[{at:now,action:'imported',actor:actor(req),toStatus:'open',note:'Imported for staff review'}]}},
      {upsert:true});
    if(existing.upsertedCount)created++;else duplicates++;
  }
  res.json({success:true,data:{created,duplicates,processed:clean.length,warning:'Imported contacts are not automatically authorized for messaging.'}});
}));
router.post('/opportunities/:id/action',wrap(async(req,res)=>{
  const business=await scoped(req);
  const doc=await getOpp(business,req.params.id);
  const kind=str(req.body?.action,40);
  const actions={claim:'claimed',contacted:'contacted',booked:'booked',completed:'completed',payment_recorded:'payment_recorded',lost:'lost',declined:'declined',close:'closed'};
  const note=str(req.body?.note,1000);
  const assignee=str(req.body?.assignee,140);
  const patch={};
  let target=doc.status;
  if(kind==='note') {if(!note)throw bad('A note is required');}
  else if(kind==='set_due') {patch.dueAt=validDueAt(req.body?.dueAt);}
  else if(kind==='assign') {if(!assignee)throw bad('Assignee is required');patch.assignee=assignee;}
  else if(kind==='suppress_contact') {patch.contactPermission='opted_out';}
  else if(kind in actions){target=assertTransition(doc.status,actions[kind]);patch.status=target;}
  else throw bad('Invalid recovery action');
  if(kind==='claim'){patch.assignee=assignee||actor(req);}
  if(kind==='booked'){
    patch.bookedCents=moneyToCents(req.body?.bookedDollars,'bookedDollars');
    if(patch.bookedCents===null)throw bad('Booked value is required');
  }
  if(kind==='payment_recorded'){
    const amount=moneyToCents(req.body?.paidDollars,'paidDollars');
    const reference=str(req.body?.paymentEvidence,400);
    if(amount===null||!reference)throw bad('Recorded payment requires an amount and evidence reference');
    patch.paymentRecordedCents=amount;
    patch.paymentEvidence=reference;
    patch.paymentEvidenceSource='owner_reported'; // Never mislabel as independently verified.
  }
  if(['lost','declined','close'].includes(kind) && !note)throw bad('Closing an opportunity requires a reason');
  if(['completed','payment_recorded','lost','declined','close'].includes(kind))patch.outcomeAt=new Date();
  patch.lastActionAt=new Date();
  const entry={at:new Date(),action:kind,actor:actor(req),fromStatus:doc.status,toStatus:target,note};
  // Compare-and-swap prevents two conflicting owner actions from both succeeding.
  const updated=await RevenueRescueOpportunity.findOneAndUpdate({business,_id:doc._id,revision:doc.revision},
    {$set:patch,$inc:{revision:1},$push:{history:{$each:[entry],$slice:-100}}},
    {new:true,runValidators:true});
  if(!updated)throw bad('Opportunity changed; refresh and retry',409);
  res.json({success:true,data:view(updated)});
}));
router.post('/sync-conversions',wrap(async(req,res)=>{
  const business=await scoped(req);
  // Bounded, repeatable, no external provider side effects. Covers sources already tracked by MeekCall.
  const events=await ConversionEvent.find({business,type:{$in:['missed_call','appointment_canceled','appointment_offered']}})
    .sort({occurredAt:-1,_id:-1}).limit(300).lean();
  const leadIds=[...new Set(events.map(e=>String(e.lead||'')).filter(Boolean))];
  const leads=await Lead.find({business,_id:{$in:leadIds}}).select('_id customerName phone serviceNeeded status estimatedValue').lean();
  const byLead=new Map(leads.map(l=>[String(l._id),l]));
  let created=0,duplicates=0,skipped=0;
  for(const ev of events){
    const lead=byLead.get(String(ev.lead));
    if(!lead || lead.status==='spam' || (lead.status==='booked' && ev.type!=='appointment_canceled')){skipped++;continue;}
    // An offered appointment is *potentially* abandoned only after at least 24 hours.
    // A canceled appointment is only a *potential* capacity opening until staff verifies it.
    if(ev.type==='appointment_offered' && Date.now()-new Date(ev.occurredAt).getTime()<24*60*60*1000){skipped++;continue;}
    const type=ev.type==='appointment_canceled'?'cancellation_capacity':ev.type==='appointment_offered'?'abandoned_booking':'missed_call';
    const externalKey=type==='cancellation_capacity'&&ev.appointment?`appointment:${ev.appointment}`:`lead:${lead._id}`;
    // Only create records; never override an owner action or customer preference.
    const result=await RevenueRescueOpportunity.updateOne({business,type,externalKey},{$setOnInsert:{
      business,type,externalKey,lead:lead._id,appointment:ev.appointment||null,
      sourceSystem:'conversion_event',title:cleanString(lead.serviceNeeded||type,200)||'Customer opportunity',
      customerName:str(lead.customerName,180),phone:str(lead.phone,40),
      estimatedCents:Number.isFinite(Number(lead.estimatedValue)) && Number(lead.estimatedValue)>=0 && Number(lead.estimatedValue)<=100000000 ? Math.round(Number(lead.estimatedValue)*100) : null,
      status:'open',contactPermission:'unknown',
      history:[{at:new Date(),action:'auto_detected',actor:'conversion_sync',toStatus:'open',note:'Potential opportunity only. Verify status before any customer outreach'}]
    }},{upsert:true});
    if(result.upsertedCount)created++;else duplicates++;
  }
  res.json({success:true,data:{created,duplicates,skipped,scanned:events.length,limit:300,warning:'No outbound messages were sent.'}});
}));
export default router;
