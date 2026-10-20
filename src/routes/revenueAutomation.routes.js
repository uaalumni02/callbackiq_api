/** MeekCall-owned records and campaigns; no external Jobber account is required. */
import express from 'express';
import mongoose from 'mongoose';
import checkAuth from '../middleware/check-auth.js';
import checkSubscription from '../middleware/check-subscription.js';
import getOwnedBusiness from '../services/businessScope.service.js';
import RevenueRescueOpportunity from '../models/revenueRescueOpportunity.js';
import InternalRevenueRecord from '../models/internalRevenueRecord.js';
import RevenueAutomationConsent from '../models/revenueAutomationConsent.js';
import RevenueAutomationCampaign from '../models/revenueAutomationCampaign.js';
import RevenueAutomationAttempt from '../models/revenueAutomationAttempt.js';
import RevenueAutomationSettings from '../models/revenueAutomationSettings.js';
import {prepareInternalRecoveryDraft} from '../services/revenueInternalDraft.service.js';
import {PURPOSE_BY_TYPE,PURPOSES,VALID_RECORD_STATUSES,validateRecordTransition,clean,cents,validHttpsUrl,httpError} from '../services/revenueAutomationPolicy.js';

const router=express.Router();router.use(checkAuth,checkSubscription);
const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
const actor=req=>String(req.user?.userId||'unknown');
const scoped=async(req)=>{const b=await getOwnedBusiness({user:req.user,requestedBusinessId:req.query?.businessId||req.body?.businessId});return b._id;};
const oid=id=>{if(!mongoose.isObjectIdOrHexString(id))throw httpError('Invalid identifier');return id;};
const ensureRecord=async(b,id)=>{const row=await InternalRevenueRecord.findOne({business:b,_id:oid(id)});if(!row)throw httpError('Record not found',404);return row;};
const ensureCampaign=async(b,id)=>{const row=await RevenueAutomationCampaign.findOne({business:b,_id:oid(id)});if(!row)throw httpError('Campaign not found',404);return row;};
const isoDate=(v)=>{if(v==null||v==='')return null;const d=new Date(v);if(!Number.isFinite(+d))throw httpError('Invalid date');return d;};
const PHONE=/^\+1\d{10}$/;
const initial={estimate:'draft',job:'draft',invoice:'draft'};
const internalType={estimate:'unsold_estimate',invoice:'unpaid_invoice'};
const boundInt=(x,lo,hi,name)=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<lo||n>hi)throw httpError(`Invalid ${name}`);return n;};
const listFilter=(req,b)=>({business:b,...(req.query.recordType?{recordType:req.query.recordType}:{})});

router.get('/catalog',wrap(async(req,res)=>{await scoped(req);res.json({success:true,data:{recordTypes:['estimate','job','invoice'],recordStatuses:VALID_RECORD_STATUSES,purposes:PURPOSES,serverSendEnabled:process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED==='true',note:'Creating a record does not authorize outreach. Jobber is not required.'}});}));
router.get('/dashboard',wrap(async(req,res)=>{
 const b=await scoped(req);
 const [rows, campaigns,attempts]=await Promise.all([
 InternalRevenueRecord.find({business:b}).select('recordType status amountCents paidCents evidenceSource').limit(2000).lean(),
 RevenueAutomationCampaign.countDocuments({business:b,state:'scheduled'}),
 RevenueAutomationAttempt.countDocuments({business:b,status:'delivered'})
 ]);
 const data={estimatesOpenCents:0,invoicesOutstandingCents:0,ownerReportedPaymentsCents:0,providerVerifiedPaymentsCents:0,scheduledCampaigns:campaigns,deliveredMessages:attempts,records:rows.length};
 for(const r of rows){if(r.recordType==='estimate'&&!['accepted','declined','canceled'].includes(r.status))data.estimatesOpenCents+=r.amountCents;
 if(r.recordType==='invoice'&&!['paid','void'].includes(r.status))data.invoicesOutstandingCents+=Math.max(0,r.amountCents-r.paidCents);
 if(r.recordType==='invoice'){if(r.evidenceSource==='provider_verified')data.providerVerifiedPaymentsCents+=r.paidCents;else data.ownerReportedPaymentsCents+=r.paidCents;}}
 res.setHeader('Cache-Control','private, no-store');res.json({success:true,data:{...data,note:'Owner-reported payments are not independently verified revenue; no incremental attribution is claimed.'}});
}));
router.get('/records',wrap(async(req,res)=>{const b=await scoped(req);const type=req.query.recordType;if(type&&!initial[type])throw httpError('Invalid record type');const limit=boundInt(req.query.limit||60,1,100,'limit');const rows=await InternalRevenueRecord.find(listFilter(req,b)).sort({updatedAt:-1}).limit(limit).lean();res.setHeader('Cache-Control','private, no-store');res.json({success:true,data:rows});}));
router.post('/records',wrap(async(req,res)=>{
 const b=await scoped(req);const v=req.body||{};
 if(!initial[v.recordType])throw httpError('Invalid record type');
 const reference=clean(v.reference,90),title=clean(v.title,200),customerPhone=clean(v.customerPhone,40);
 if(!reference||!title)throw httpError('Reference and title are required');
 if(customerPhone&&!PHONE.test(customerPhone))throw httpError('Phone must be U.S. E.164');
 const amountCents=cents(v.amountDollars??0),dueAt=isoDate(v.dueAt);
 const status=initial[v.recordType];
 // Unique, retry-safe parent opportunity for estimates and invoices; jobs can link later.
 let opportunity=null;
 if(internalType[v.recordType]){
  const type=internalType[v.recordType],externalKey=`internal:${v.recordType}:${reference}`;
  opportunity=await RevenueRescueOpportunity.findOneAndUpdate({business:b,type,externalKey},{
   $setOnInsert:{business:b,type,externalKey,sourceSystem:'meekcall_internal',title,customerName:clean(v.customerName,180),phone:customerPhone,
    estimatedCents:amountCents,status:'open',contactPermission:'unknown',history:[{at:new Date(),actor:actor(req),action:'internal_record',toStatus:'open',note:'Created from MeekCall internal record'}]}
  },{upsert:true,returnDocument:'after'});
 }else if(v.opportunityId){
  opportunity=await RevenueRescueOpportunity.findOne({business:b,_id:oid(v.opportunityId)});
  if(!opportunity)throw httpError('Linked opportunity not found in this business',404);
 }
 try{
  const created=await InternalRevenueRecord.create({business:b,opportunity:opportunity?._id||null,recordType:v.recordType,reference,title,
   customerName:clean(v.customerName,180),customerPhone,description:clean(v.description,1500),status,amountCents,dueAt,
   paymentUrl:validHttpsUrl(v.paymentUrl),history:[{actor:actor(req),action:'created',note:'Internal record created for review'}]});
  res.status(201).json({success:true,data:created});
 }catch(err){if(err.code===11000)throw httpError('Record reference already exists',409);throw err;}
}));
router.patch('/records/:id',wrap(async(req,res)=>{
 const b=await scoped(req),record=await ensureRecord(b,req.params.id),v=req.body||{},patch={};
 const rev=record.revision;
 if(v.status!==undefined)patch.status=validateRecordTransition(record.recordType,record.status,v.status);
 if(v.description!==undefined)patch.description=clean(v.description,1500);
 if(v.dueAt!==undefined)patch.dueAt=isoDate(v.dueAt);
 if(v.paymentUrl!==undefined)patch.paymentUrl=validHttpsUrl(v.paymentUrl);
 if(v.amountDollars!==undefined){if(record.paidCents)throw httpError('Cannot revise quoted amount after payment');patch.amountCents=cents(v.amountDollars);}
 if(v.paidDollars!==undefined){
  if(record.recordType!=='invoice'||!['issued','partially_paid'].includes(record.status))throw httpError('Payment requires an issued invoice');
  if(!clean(v.paymentEvidence,300))throw httpError('Payment evidence reference is required');
  patch.paidCents=cents(v.paidDollars);if(patch.paidCents>record.amountCents||patch.paidCents<=record.paidCents)throw httpError('Payments must be cumulative and cannot exceed invoice amount');
  patch.status=patch.paidCents===record.amountCents?'paid':'partially_paid';
  patch.paymentEvidenceRef=clean(v.paymentEvidence,300);
  patch.evidenceSource='owner_reported'; // Never accept provider verification from an owner request.
 }
 if(['paid','partially_paid'].includes(patch.status)&&v.paidDollars===undefined)throw httpError('Payment amount and evidence required');
 if(Object.keys(patch).length===0)throw httpError('No valid fields');
 const note=clean(v.note||v.paymentEvidence,500);
 const updated=await InternalRevenueRecord.findOneAndUpdate({_id:record._id,business:b,revision:rev},{$set:patch,$inc:{revision:1},$push:{history:{$each:[{actor:actor(req),action:'updated',note}],$slice:-100}}},{returnDocument:'after',runValidators:true});
 if(!updated)throw httpError('Record was updated by another user; refresh',409);
 await prepareInternalRecoveryDraft(updated);
 res.json({success:true,data:updated});
}));
router.get('/consents',wrap(async(req,res)=>{const b=await scoped(req);const rows=await RevenueAutomationConsent.find({business:b}).select('-__v').sort({updatedAt:-1}).limit(100).lean();res.json({success:true,data:rows});}));
router.post('/consents',wrap(async(req,res)=>{
 const b=await scoped(req),v=req.body||{},phone=clean(v.phone,40),purpose=clean(v.purpose,50),evidence=clean(v.evidence,500);
 if(!PHONE.test(phone)||!PURPOSES.includes(purpose)||!evidence||!['express_written','documented_transactional_request'].includes(v.basis))throw httpError('Explicit purpose, valid phone, consent basis and evidence are required');
 if(['service_reactivation','capacity_offer'].includes(purpose)&&v.basis!=='express_written')throw httpError('Reactivation requires documented marketing consent');
 if(v.confirmConsentRecorded!==true)throw httpError('Owner attestation is required');
 const consentAt=isoDate(v.consentAt);if(!consentAt||consentAt>new Date()||consentAt<new Date('2020-01-01'))throw httpError('Invalid consent date');
 const expiresAt=isoDate(v.expiresAt);if(expiresAt&&expiresAt<=new Date())throw httpError('Consent expiry must be in future');
 const row=await RevenueAutomationConsent.findOneAndUpdate({business:b,phone,purpose},{$set:{basis:v.basis,evidence,status:'verified',consentAt,expiresAt,recordedBy:actor(req),revokedAt:null}}, {upsert:true,returnDocument:'after',runValidators:true});
 res.json({success:true,data:row});
}));
router.post('/consents/revoke',wrap(async(req,res)=>{const b=await scoped(req),phone=clean(req.body?.phone,40);if(!PHONE.test(phone))throw httpError('Invalid phone');const purpose=req.body?.purpose;if(purpose&&!PURPOSES.includes(purpose))throw httpError('Invalid purpose');await RevenueAutomationConsent.updateMany({business:b,phone,...(purpose?{purpose}:{})},{$set:{status:'revoked',revokedAt:new Date()}});await RevenueAutomationCampaign.updateMany({business:b,phone,...(purpose?{purpose}:{}),state:{$in:['draft','scheduled','paused']}},{$set:{state:'suppressed',lastStatus:'consent_revoked'}});res.json({success:true,data:{revoked:true}});}));
router.get('/settings',wrap(async(req,res)=>{const b=await scoped(req);const settings=await RevenueAutomationSettings.findOne({business:b}).lean();res.json({success:true,data:{enabled:false,liveSendingEnabled:false,maxMessagesPerDay:5,quietStartHour:20,quietEndHour:9,...settings,serverSendEnabled:process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED==='true'}});}));
router.patch('/settings',wrap(async(req,res)=>{const b=await scoped(req),v=req.body||{};
 const allowed=['enabled','liveSendingEnabled','maxMessagesPerDay','quietStartHour','quietEndHour','humanEscalationMinutes'];
 if(Object.keys(v).some(x=>!allowed.includes(x)&&x!=='businessId'))throw httpError('Unsupported setting');const patch={};
 for(const key of ['enabled','liveSendingEnabled'])if(v[key]!==undefined){if(typeof v[key]!=='boolean')throw httpError('Invalid boolean setting');patch[key]=v[key];}
 for(const [key,min,max] of [['maxMessagesPerDay',1,25],['quietStartHour',0,23],['quietEndHour',0,23],['humanEscalationMinutes',5,1440]])if(v[key]!==undefined)patch[key]=boundInt(v[key],min,max,key);
 if(!Object.keys(patch).length)throw httpError('No valid settings');
 const row=await RevenueAutomationSettings.findOneAndUpdate({business:b},{$set:patch,$setOnInsert:{business:b},$inc:{revision:1}},{upsert:true,returnDocument:'after',runValidators:true});res.json({success:true,data:{...row.toObject(),serverSendEnabled:process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED==='true'}});
}));
router.get('/campaigns',wrap(async(req,res)=>{const b=await scoped(req);const rows=await RevenueAutomationCampaign.find({business:b}).sort({updatedAt:-1}).limit(100).lean();res.json({success:true,data:rows});}));
router.post('/campaigns',wrap(async(req,res)=>{
 const b=await scoped(req),v=req.body||{};
 const opportunity=await RevenueRescueOpportunity.findOne({business:b,_id:oid(v.opportunityId)});
 if(!opportunity)throw httpError('Opportunity not found',404);
 const purpose=PURPOSE_BY_TYPE[opportunity.type];if(!purpose||purpose!==v.purpose)throw httpError('Purpose must match recovery category');
 const phone=clean(v.phone||opportunity.phone,40);if(!PHONE.test(phone)|| (opportunity.phone&&phone!==opportunity.phone))throw httpError('Invalid or mismatched customer phone');
 const template=clean(v.template,700);if(!template||template.includes('http://'))throw httpError('Approved follow-up template required');
 let record=null;
 if(v.recordId){record=await ensureRecord(b,v.recordId);if(record.opportunity&&String(record.opportunity)!==String(opportunity._id))throw httpError('Record belongs to another opportunity',409);if(record.customerPhone&&record.customerPhone!==phone)throw httpError('Record contact differs');}
 let row;try{row=await RevenueAutomationCampaign.create({business:b,opportunity:opportunity._id,record:record?._id||null,phone,purpose,template,executeAt:isoDate(v.executeAt)||new Date(Date.now()+24*3600_000),state:'draft',history:[{status:'draft',reason:'Awaiting explicit owner approval'}]});}
 catch(e){if(e.code===11000)throw httpError('Campaign already exists for this opportunity and purpose',409);throw e;}
 res.status(201).json({success:true,data:row});
}));
router.post('/campaigns/:id/action',wrap(async(req,res)=>{
 const b=await scoped(req),row=await ensureCampaign(b,req.params.id),action=clean(req.body?.action,30);const patch={};
 if(action==='schedule'){
  if(!['draft','paused'].includes(row.state))throw httpError('Campaign cannot be scheduled from current state');
  const when=isoDate(req.body?.executeAt)||row.executeAt;
  if(when<new Date(Date.now()-60_000))throw httpError('Cannot schedule in the past');
  patch.executeAt=when;patch.state='scheduled';patch.approvedAt=new Date();patch.approvedBy=actor(req);
  if(req.body?.maxSends!==undefined)patch.maxSends=boundInt(req.body.maxSends,1,3,'maxSends');
  if(req.body?.intervalHours!==undefined)patch.intervalHours=boundInt(req.body.intervalHours,24,720,'intervalHours');
 }else if(action==='pause'&&['scheduled','draft'].includes(row.state))patch.state='paused';
 else if(action==='cancel'&&!['completed','canceled','processing'].includes(row.state))patch.state='canceled';
 else throw httpError('Invalid campaign action');
 const result=await RevenueAutomationCampaign.findOneAndUpdate({_id:row._id,business:b,revision:row.revision,state:row.state},{$set:patch,$inc:{revision:1},$push:{history:{$each:[{status:patch.state,reason:`Owner action ${action}`}],$slice:-100}}},{returnDocument:'after',runValidators:true});
 if(!result)throw httpError('Campaign changed; refresh',409);
 res.json({success:true,data:result});
}));
router.get('/attempts',wrap(async(req,res)=>{const b=await scoped(req);const rows=await RevenueAutomationAttempt.find({business:b}).sort({createdAt:-1}).limit(100).lean();res.json({success:true,data:rows});}));
export default router;
