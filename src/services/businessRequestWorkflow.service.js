import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Alert from '../models/alert.js';
import Conversation from '../models/conversation.js';
import Lead from '../models/lead.js';
import Appointment from '../models/appointment.js';
import Message from '../models/message.js';
import AppointmentNotificationJob from '../models/appointmentNotificationJob.js';
import VoiceSession from '../models/voiceSession.js';
import { requestReviewKey } from './requestReview.service.js';
import { withDistributedLease, assertDistributedLeaseActive } from './distributedLease.service.js';
import { queryBudgetMs } from './scale/queryBudget.js';
import { unknownEstimate } from './valuation/opportunityValue.js';
import { extractCustomerPostalCode } from './booking/customerAddress.service.js';
import SocketService from './socket.service.js';

const outcomeLabels={booked:'Booked',customer_declined:'Customer declined',unable_to_service:'Unable to service',follow_up:'Follow-up needed',issue_resolved:'Issue addressed'};
const factLabels={customerName:'Customer name',serviceNeeded:'Service',address:'Address',preferredAppointmentTime:'Requested time'};
const id = value => String(value?._id || value || '');
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, code: 'REQUEST_WORKFLOW_CONFLICT' });
export const ordinaryReview = row => row?.type === 'human_requested' && /^(ai_review|human_handoff|request_review):/.test(row.dedupeKey || '') &&
  !['emergency', 'hazardous_diy_request'].includes(row.metadata?.messageCategory) &&
  !(row.metadata?.riskFlags || []).some(flag => ['safety_hazard', 'hazardous_diy_request'].includes(flag));
export function reviewJourney(row, conversation) {
  if (!ordinaryReview(row) || !conversation) return null;
  if (row.metadata?.reviewJourneyKey !== undefined) return String(row.metadata.reviewJourneyKey);
  const started = conversation.orchestration?.recoveryJourneyStartedAt;
  const journey = conversation.orchestration?.recoveryJourneyKey;
  // A conversation ID alone does not prove two legacy records are one request.
  return journey && started && new Date(row.createdAt) >= new Date(started) ? journey : null;
}
export const workflowVersion = data => crypto.createHash('sha256').update(JSON.stringify([
  data.conversation, data.lead, data.appointment, data.latestOutbound, data.confirmationNotice,
  data.members.map(row => [id(row), row.updatedAt, row.resolvedAt, row.assignedTo, row.metadata?.workflow]).sort((a,b)=>a[0].localeCompare(b[0])),
])).digest('hex');
export function combinedReview(members) {
  const sorted = [...members].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  const canonical = sorted.find(row => row.metadata?.requestReview) || sorted.find(row=>row.acknowledgedAt) || sorted[0];
  const latest = [...sorted].reverse().find(row=>row.metadata?.intakeReview) || sorted.at(-1);
  const events = sorted.flatMap(row => row.reviewEvents?.length ? row.reviewEvents : [{ key:`legacy:${id(row)}`, occurredAt:row.createdAt,
    title:row.title, message:row.message, messageId:row.metadata?.messageId, providerMessageId:row.metadata?.providerMessageId }]);
  const rank = {low:0,medium:1,high:2,critical:3};
  const owner=sorted.find(row=>row.assignedTo),ack=sorted.find(row=>row.acknowledgedAt);
  return { ...canonical, ...(owner?{assignedTo:owner.assignedTo,assignedAt:owner.assignedAt,assignedBy:owner.assignedBy}:{}),
    ...(ack?{acknowledgedAt:ack.acknowledgedAt,acknowledgedBy:ack.acknowledgedBy}:{}),workflowKind:ordinaryReview(canonical)?'request':'exception', title:latest.title, message:latest.message, recommendedAction:latest.recommendedAction,
    metadata:{...canonical.metadata,...latest.metadata}, aiSummary:latest.aiSummary, lastCustomerMessage:latest.lastCustomerMessage,
    priority:[...sorted].sort((a,b)=>(rank[b.priority]||0)-(rank[a.priority]||0))[0].priority,
    reviewEvents:[...new Map(events.map(event=>[event.key,event])).values()].sort((a,b)=>new Date(a.occurredAt)-new Date(b.occurredAt)),
    memberIds:sorted.map(id), legacyConsolidationRequired:members.length>1 };
}

// Group before filtering/pagination: a request never loses half its history at
// the page boundary, and an older matching event still finds the whole request.
export async function listBusinessRequests({ businessId, query }) {
  const business = new mongoose.Types.ObjectId(id(businessId));
  const match = { business, 'metadata.supersededBy': { $exists:false } };
  for (const [parameter,field] of [['leadId','lead'],['conversationId','conversation']]) if(query[parameter]) {
    if(!mongoose.isObjectIdOrHexString(query[parameter])) throw fail(`Invalid ${parameter}`,400);
    match[field]=new mongoose.Types.ObjectId(query[parameter]);
  }
  if(query.resolved==='true') match.resolvedAt={$ne:null}; else if(query.resolved!=='all') match.resolvedAt=null;
  match.type={$in:['human_requested','safety_emergency','angry_customer','low_ai_confidence','booking_conflict','integration_failure','message_delivery_failure','unanswered_hot_lead','appointment_canceled','appointment_change_review','system','hot_lead']};
  match.$or=[{type:{$nin:['system','hot_lead']}},{type:'hot_lead',priority:'critical'},{type:'system',priority:'critical',$or:[{'metadata.messageCategory':'emergency'},{'metadata.riskFlags':{$in:['safety_hazard','hazardous_diy_request']}}]}];
  const ordinary = {$and:[{$eq:['$type','human_requested']},{$regexMatch:{input:{$ifNull:['$dedupeKey','']},regex:'^(ai_review|human_handoff|request_review):'}},
    {$not:[{$in:['$metadata.messageCategory',['emergency','hazardous_diy_request']]}]},
    {$eq:[{$size:{$setIntersection:[{$ifNull:['$metadata.riskFlags',[]]},['safety_hazard','hazardous_diy_request']]}},0]}]};
  const journey = {$ifNull:['$metadata.reviewJourneyKey',{$cond:[{$and:[{$ne:[{$ifNull:['$__conversation.orchestration.recoveryJourneyKey','']},'']},
    {$ne:[{$ifNull:['$__conversation.orchestration.recoveryJourneyStartedAt',null]},null]},{$gte:['$createdAt','$__conversation.orchestration.recoveryJourneyStartedAt']}]},'$__conversation.orchestration.recoveryJourneyKey',null]}]};
  const pipeline=[{$match:match},{$lookup:{from:Conversation.collection.name,let:{cid:'$conversation'},pipeline:[{$match:{$expr:{$and:[{$eq:['$_id','$$cid']},{$eq:['$business',business]}]}}},{$project:{orchestration:1}}],as:'__conversation'}},
    {$set:{__conversation:{$first:'$__conversation'}}},{$set:{__journey:journey}},{$set:{__group:{$cond:[{$and:[ordinary,{$ne:['$__journey',null]},{$eq:[{$ifNull:['$resolvedAt',null]},null]}]},
      {$concat:[{$toString:'$conversation'},':','$__journey']},{$toString:'$_id'}]}}},{$unset:['__conversation','__journey']},
    {$group:{_id:'$__group',rows:{$push:'$$ROOT'},updatedAt:{$max:'$updatedAt'},priority:{$max:{$switch:{branches:[{case:{$eq:['$priority','critical']},then:4},{case:{$eq:['$priority','high']},then:3},{case:{$eq:['$priority','medium']},then:2}],default:1}}}}}];
  if(query.priority) pipeline.push({$match:{'rows.priority':query.priority}});
  if(query.search) {
    const expression=new RegExp(String(query.search).slice(0,120).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
    pipeline.push({$lookup:{from:Lead.collection.name,localField:'rows.lead',foreignField:'_id',pipeline:[{$match:{business}},{$project:{customerName:1,phone:1}}],as:'__leads'}},
      {$match:{$or:['rows.title','rows.message','rows.aiSummary','rows.lastCustomerMessage','__leads.customerName','__leads.phone'].map(field=>({[field]:expression}))}});
  }
  const skip=Math.max(0,Math.min(10000,Math.floor(Number(query.skip)||0))),limit=50;
  pipeline.push({$sort:{priority:-1,updatedAt:-1,_id:1}},{$facet:{count:[{$count:'total'}],page:[{$skip:skip},{$limit:limit}]}});
  const [result]=await Alert.aggregate(pipeline).option({maxTimeMS:queryBudgetMs()});
  const data=(result?.page||[]).map(group=>combinedReview(group.rows));
  await Alert.populate(data,[{path:'lead',select:'customerName phone serviceNeeded urgency estimatedValue valuation status address preferredAppointmentTime'},
    {path:'conversation',select:'customerName customerPhone humanTakeover bookingState status'}, {path:'assignedTo',select:'userName email'}, {path:'appointment',select:'startAt endAt timezone status'}]);
  const total=result?.count?.[0]?.total||0;
  return {data,total,skip,hasMore:skip+data.length<total};
}

export async function readRequestWorkflow({businessId,alertId,session=null}) {
  if(!mongoose.isObjectIdOrHexString(alertId)) throw fail('Invalid review ID',400);
  let alert=await Alert.findOne({_id:alertId,business:businessId}).session(session).lean();
  if(alert?.metadata?.supersededBy) alert=await Alert.findOne({_id:alert.metadata.supersededBy,business:businessId}).session(session).lean();
  if(!alert) throw fail('Review not found',404);
  const conversation=alert.conversation?await Conversation.findOne({_id:alert.conversation,business:businessId}).session(session).lean():null;
  const lead=alert.lead?await Lead.findOne({_id:alert.lead,business:businessId}).session(session).lean():null;
  const journey=reviewJourney(alert,conversation);
  let members=[alert];
  if(journey!==null && !alert.resolvedAt) {
    const candidates=await Alert.find({business:businessId,conversation:alert.conversation,type:'human_requested',resolvedAt:null,'metadata.supersededBy':{$exists:false}}).limit(251).session(session).lean();
    if(candidates.length>250) throw fail('This conversation has too many legacy reviews for automatic consolidation. Review it with support.');
    members=candidates.filter(row=>reviewJourney(row,conversation)===journey && id(row.lead)===id(alert.lead));
  }
  const apptId=conversation?.bookingState?.appointment || alert.appointment;
  const appointment=apptId?await Appointment.findOne({_id:apptId,business:businessId,conversation:alert.conversation}).session(session).lean():null;
  const latestOutbound=conversation?await Message.findOne({business:businessId,conversation:conversation._id,direction:'outbound'}).sort({createdAt:-1,_id:-1})
    .select('body status deliveryStatus deliveryUncertain createdAt').session(session).lean():null;
  const confirmationJob=appointment?await AppointmentNotificationJob.findOne({business:businessId,appointment:appointment._id,key:'change_notice:business_approval_confirmed'}).session(session).lean():null;
  const confirmationMessage=confirmationJob?.providerMessageId?await Message.findOne({business:businessId,conversation:alert.conversation,direction:'outbound',providerMessageId:confirmationJob.providerMessageId}).select('status deliveryStatus deliveryUncertain createdAt').session(session).lean():null;
  const confirmationNotice=confirmationJob?{status:confirmationJob.status,deliveryStatus:confirmationMessage?.deliveryUncertain?'unverified':confirmationMessage?.deliveryStatus||confirmationMessage?.status||'unverified',sentAt:confirmationJob.sentAt}:null;
  const data={review:combinedReview(members),members,conversation,lead,appointment,latestOutbound,confirmationNotice,journey};
  data.version=workflowVersion(data);
  return data;
}

export function validateOutcome(input, snapshot, now=new Date()) {
  const allowed=ordinaryReview(snapshot.review)?['booked','customer_declined','unable_to_service','follow_up']:['issue_resolved','follow_up'];
  if(!allowed.includes(input.outcome)) throw fail('Choose an outcome for this type of request.',400);
  if(typeof input.reason!=='string'||input.reason.trim().length<5||input.reason.trim().length>1000) throw fail('Enter a reason of 5–1000 characters.',400);
  if(input.outcome==='booked'&&!['confirmed','completed'].includes(snapshot.appointment?.status)) throw fail('Book and confirm the appointment before recording a booked outcome.');
  if(['customer_declined','unable_to_service'].includes(input.outcome)&&snapshot.appointment&&!['canceled','failed','expired'].includes(snapshot.appointment.status)) throw fail('Manage the existing appointment before closing this request.');
  if(input.outcome==='follow_up'&&(typeof input.followUpAt!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(input.followUpAt)||!Number.isFinite(Date.parse(input.followUpAt))||Date.parse(input.followUpAt)<=now.getTime()||Date.parse(input.followUpAt)>now.getTime()+366*86400000)) throw fail('Choose a future follow-up time within one year.',400);
}
const factLimits={customerName:120,serviceNeeded:200,address:500,preferredAppointmentTime:500};
export function validateFacts(changes) {
  if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length) throw fail('Enter the details to correct.',400);
  for(const [key,value] of Object.entries(changes)) if(!factLimits[key]||typeof value!=='string'||value.trim().length>factLimits[key]||
    (key==='customerName'&&/^(missed call lead|new sms lead|unknown|customer)$/i.test(value.trim()))) throw fail('Check the customer name, service, address, and requested time.',400);
  return Object.fromEntries(Object.entries(changes).map(([key,value])=>[key,value.trim()]));
}

async function consolidate(snapshot,businessId,session,now) {
  const {review,members,conversation,journey}=snapshot;
  if(!ordinaryReview(review)||journey===null) return review._id;
  const key=requestReviewKey(conversation._id,journey);
  const existing=await Alert.findOne({business:businessId,dedupeKey:key}).session(session).lean();
  if(existing&&!members.some(row=>id(row)===id(existing))) throw fail('A different canonical review exists. Refresh before continuing.');
  const owners=new Set(members.map(row=>id(row.assignedTo)).filter(Boolean));
  if(owners.size>1) throw fail('These reviews have conflicting owners. Resolve assignment before combining them.');
  const assigned=members.find(row=>row.assignedTo),ack=members.find(row=>row.acknowledgedAt);
  const canonical=existing||members.find(row=>id(row)===id(review));
  if(members.length===1 && existing) return canonical._id;
  const duplicateIds=members.filter(row=>id(row)!==id(canonical)).map(row=>row._id);
  await Alert.updateOne({_id:canonical._id,business:businessId},{$set:{dedupeKey:key,title:review.title,message:review.message,
    recommendedAction:review.recommendedAction,aiSummary:review.aiSummary,lastCustomerMessage:review.lastCustomerMessage,priority:review.priority,
    metadata:{...canonical.metadata,...review.metadata,requestReview:true,reviewJourneyKey:journey},reviewEvents:review.reviewEvents,
    reviewPhase:review.metadata?.intakeReview?2:1,reviewLatestAt:members.map(row=>row.reviewLatestAt||row.createdAt).sort((a,b)=>new Date(b)-new Date(a))[0],
    ...(assigned?{assignedTo:assigned.assignedTo,assignedAt:assigned.assignedAt,assignedBy:assigned.assignedBy}:{}),
    ...(ack?{acknowledgedAt:ack.acknowledgedAt,acknowledgedBy:ack.acknowledgedBy,status:'acknowledged'}:{}),
    dueAt:members.map(row=>row.dueAt).filter(Boolean).sort((a,b)=>new Date(a)-new Date(b))[0]||null}}, {session,runValidators:true});
  if(duplicateIds.length) await Alert.updateMany({_id:{$in:duplicateIds},business:businessId},{$set:{actionRequired:false,status:'resolved',resolvedAt:now,
    resolution:`Consolidated into active request ${canonical._id}.`, 'metadata.supersededBy':id(canonical),'metadata.consolidatedAt':now}},{session});
  return canonical._id;
}

export async function updateRequestWorkflow({business,userId,alertId,input}) {
  if(!['accept','consolidate','facts','outcome'].includes(input.action)||!/^[-a-zA-Z0-9_:]{10,160}$/.test(input.operationId||'')) throw fail('A valid action and operation ID are required.',400);
  const operationHash=crypto.createHash('sha256').update(JSON.stringify({action:input.action,changes:input.changes,outcome:input.outcome,reason:input.reason,followUpAt:input.followUpAt})).digest('hex');
  const initial=await readRequestWorkflow({businessId:business._id,alertId});
  const run=async()=>{
    let resultId;
    try {
      await mongoose.connection.transaction(async session=>{
        const snapshot=await readRequestWorkflow({businessId:business._id,alertId,session});
        const priorOperation=snapshot.review.reviewEvents?.find(event=>event.key===`staff:${input.operationId}`);
        if(priorOperation) {
          if(priorOperation.operationHash!==operationHash) throw fail('This operation ID was already used for a different action. Reload before continuing.');
          resultId=snapshot.review._id;return;
        }
        if(input.version!==snapshot.version) throw fail('This request changed. Reload it before saving.');
        if(snapshot.review.resolvedAt) throw fail('This request already has a final outcome.');
        if(snapshot.conversation?.status==='archived') throw fail('Restore the conversation before changing this request.');
        const now=new Date(), ordinary=ordinaryReview(snapshot.review);
        if(ordinary && snapshot.journey!==null && snapshot.journey!==(snapshot.conversation?.orchestration?.recoveryJourneyKey||'')) throw fail('This is an older request. Review the current conversation before acting.');
        if(input.action==='outcome') validateOutcome(input,snapshot,now);
        const changes=input.action==='facts'?validateFacts(input.changes):null;
        if(input.action==='facts'&&(!ordinary||!snapshot.lead||!snapshot.conversation)) throw fail('Request details are unavailable for this action.');
        if(['facts','outcome'].includes(input.action)&&(!snapshot.review.acknowledgedAt||!snapshot.review.assignedTo||(snapshot.conversation&&!snapshot.conversation.humanTakeover))) throw fail('Accept this request and pause AI before saving changes.');
        if(input.action==='facts' && (snapshot.appointment&&!['canceled','failed','expired'].includes(snapshot.appointment.status))) throw fail('Edit the existing appointment through scheduling. Its confirmed details cannot be changed here.');
        if(snapshot.conversation&&await VoiceSession.exists({business:business._id,conversation:snapshot.conversation._id,status:{$in:['routing','connecting','active','capturing_callback','completing']}}).session(session)) throw fail('Wait for the active voice call to finish before changing this request.');
        resultId=await consolidate(snapshot,business._id,session,now);
        const alertSet={},conversationSet={};
        if(input.action==='accept') {
          if(!snapshot.conversation) throw fail('No conversation is linked to this review.');
          if(snapshot.review.assignedTo&&id(snapshot.review.assignedTo)!==id(business.owner)) throw fail('This review already belongs to another staff member.');
          Object.assign(alertSet,{status:'acknowledged',assignedTo:business.owner||userId,assignedBy:snapshot.review.assignedBy||userId,assignedAt:snapshot.review.assignedAt||now,
            acknowledgedAt:snapshot.review.acknowledgedAt||now,acknowledgedBy:snapshot.review.acknowledgedBy||userId});
          Object.assign(conversationSet,{humanTakeover:true,aiEnabled:false});
        }
        if(changes) {
          const serviceChanged=changes.serviceNeeded!==undefined&&changes.serviceNeeded!==snapshot.lead.serviceNeeded;
          const schedulingChanged=['serviceNeeded','address','preferredAppointmentTime'].some(field=>changes[field]!==undefined&&changes[field]!==snapshot.lead[field]);
          const leadSet={...changes,...(serviceChanged&&snapshot.lead.valuation?.source!=='owner'?unknownEstimate('Service corrected by staff; estimate needs review'): {})};
          if(serviceChanged||changes.address!==undefined) {
            leadSet.serviceEligibility={decision:'needs_staff_review',reason:'staff_corrected_request',request:changes.serviceNeeded??snapshot.lead.serviceNeeded};
            conversationSet.serviceEligibility=leadSet.serviceEligibility;
          }
          await Lead.updateOne({_id:snapshot.lead._id,business:business._id},{$set:leadSet,...(serviceChanged?{$inc:{valuationVersion:1}}:{})},{session,runValidators:true});
          for(const [field,value] of Object.entries(changes)) {
            if(field==='customerName') conversationSet.customerName=value;
            else {conversationSet[`conversationMemory.${field}`]=value;conversationSet[`conversationMemory.recoveryIntake.${field}`]=value;}
          }
          if(schedulingChanged) Object.assign(conversationSet,{'bookingState.offeredSlots':[],'bookingState.selectedSlot':null,'bookingState.lastAvailabilityCheckedAt':null,
            'bookingState.expiresAt':null,'bookingState.preferredStart':null,'bookingState.preferredEnd':null,'bookingState.searchStartDate':'','bookingState.searchEndDate':'',
            'bookingState.status':'human_takeover','bookingState.lastCustomerPreference':changes.preferredAppointmentTime??snapshot.lead.preferredAppointmentTime,
            'bookingState.streetAddress':changes.address??snapshot.lead.address,'bookingState.postalCode':extractCustomerPostalCode(changes.address??snapshot.lead.address??''),
            'bookingState.serviceOffering':null,'conversationMemory.recoveryIntake.availability':{status:'not_checked'},'conversationMemory.recoveryIntake.readiness':{...(snapshot.conversation.conversationMemory?.recoveryIntake?.readiness||{}),availabilityVerified:false}});
          const intakeReview={...(snapshot.review.metadata?.intakeReview||{})};
          for(const field of ['serviceNeeded','address','preferredAppointmentTime']) if(changes[field]!==undefined) intakeReview[field]=changes[field];
          if(schedulingChanged) {intakeReview.availability={status:'not_checked'};intakeReview.readiness={...(intakeReview.readiness||{}),availabilityVerified:false};}
          alertSet['metadata.intakeReview']=intakeReview;
          if(schedulingChanged) alertSet.aiSummary='Request details corrected by staff. Review the current facts and recheck availability.';
        }
        if(input.action==='outcome') {
          const followUp=input.outcome==='follow_up';
          alertSet['metadata.workflow']={outcome:input.outcome,reason:input.reason.trim(),recordedAt:now,recordedBy:id(userId),followUpAt:followUp?new Date(input.followUpAt):null};
          if(followUp) Object.assign(alertSet,{actionRequired:true,dueAt:new Date(input.followUpAt)});
          else {
            Object.assign(alertSet,{actionRequired:false,status:'resolved',resolvedAt:now,resolvedBy:userId,resolution:`${outcomeLabels[input.outcome]}: ${input.reason.trim()}`});
            if(ordinary&&snapshot.conversation) {
              conversationSet['conversationMemory.recoveryIntake.review.status']='resolved';
              if(input.outcome!=='booked') Object.assign(conversationSet,{'conversationMemory.recoveryIntake.withdrawnAt':now,'bookingState.offeredSlots':[],'bookingState.selectedSlot':null,'bookingState.expiresAt':null,'bookingState.status':'human_takeover'});
              if(snapshot.lead) await Lead.updateOne({_id:snapshot.lead._id,business:business._id},{$set:{status:input.outcome==='booked'?'booked':'lost'}},{session});
            }
          }
        }
        const event={key:`staff:${input.operationId}`,operationHash,occurredAt:now,title:({accept:'Request accepted; AI paused',consolidate:'Review history consolidated',facts:'Request details corrected',outcome:'Business outcome recorded'})[input.action],
          message:input.action==='outcome'?`${outcomeLabels[input.outcome]}: ${input.reason.trim()}`:input.action==='facts'?Object.keys(changes).map(key=>factLabels[key]).join(', '):'Saved by the business owner.',actorId:id(userId),
          outcome:input.outcome||'',followUpAt:input.outcome==='follow_up'?new Date(input.followUpAt):null,
          changes:changes?Object.fromEntries(Object.entries(changes).map(([key,value])=>[key,{before:snapshot.lead[key]||'',after:value}])):undefined};
        await Alert.updateOne({_id:resultId,business:business._id},{$set:alertSet,$push:{reviewEvents:event}},{session,runValidators:true});
        if(snapshot.conversation) {
          if(ordinary) conversationSet['conversationMemory.recoveryIntake.review.alertId']=id(resultId);
          // Touch the shared conversation in the transaction to detect a racing
          // inbound turn or booking operation, even for an outcome-only change.
          conversationSet['conversationMemory.lastUpdatedAt']=now;
          await Conversation.updateOne({_id:snapshot.conversation._id,business:business._id},{$set:conversationSet},{session,runValidators:true});
        }
        assertDistributedLeaseActive();
      });
    } catch(error) {
      if(error.code===20||error.codeName==='IllegalOperation') throw fail('This action needs a transaction-capable MongoDB connection (Atlas or a replica set). No changes were saved.',503);
      throw error;
    }
    const result=await readRequestWorkflow({businessId:business._id,alertId:resultId});
    SocketService.emitAlertUpdated(business._id,result.review);
    if(result.conversation) SocketService.emitConversationUpdated(business._id,result.conversation);
    if(result.lead) SocketService.emitLeadUpdated(business._id,result.lead);
    SocketService.emitDashboardRefresh(business._id,'request:updated');
    return result;
  };
  if(!initial.conversation) return run();
  const lease=await withDistributedLease(`sms-conversation:${initial.conversation._id}`,run,{ttlMs:30000});
  if(!lease.acquired) throw fail('This customer request is being updated. Try again shortly.');
  return lease.value;
}
