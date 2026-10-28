import crypto from 'node:crypto';
import mongoose from 'mongoose';
import RecoveryCase from '../../models/recoveryCase.js';
import RecoveryEvent from '../../models/recoveryEvent.js';
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
import Alert from '../../models/alert.js';
import Appointment from '../../models/appointment.js';
import AppointmentNotificationJob from '../../models/appointmentNotificationJob.js';
import ServiceOffering from '../../models/serviceOffering.js';
import { evaluateServiceEligibility } from '../serviceEligibility/serviceEligibility.service.js';
import { fingerprintRequest } from './acceptanceGate.js';
import { contractError, validateFacts, validateDecision, requiredVersion, operationKey, normalizeFacts, nextReviewState } from './contract.js';

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const str = value => String(value?._id || value || '');
const isId = value => mongoose.isObjectIdOrHexString(str(value));
const conflict = message => contractError(message, 'RECOVERY_CONFLICT', 409);
const enabled = () => process.env.MEEKCALL_RECOVERY_COORDINATOR_ENABLED === 'true';
export const isPilotBusiness = businessId => String(process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS || '')
  .split(',').map(value => value.trim()).filter(Boolean).includes(str(businessId));
const writeThroughEnabled = () => process.env.MEEKCALL_RECOVERY_WRITE_THROUGH === 'true';
export function requireCoordinatorEnabled(businessId) {
  if (!enabled() || !isPilotBusiness(businessId)) throw contractError('Not found.', 'RECOVERY_DISABLED', 404);
}
async function linked(businessId, conversationId, session = null) {
  if (!isId(conversationId)) throw contractError('Invalid conversation ID.');
  const conversation = await Conversation.findOne({ _id: conversationId, business: businessId }).session(session).lean();
  if (!conversation || !isId(conversation.lead)) throw contractError('Active conversation and linked lead required.', 'RECOVERY_NOT_FOUND', 404);
  const lead = await Lead.findOne({ _id: conversation.lead, business: businessId }).session(session).lean();
  if (!lead) throw contractError('Lead does not belong to this business.', 'RECOVERY_NOT_FOUND', 404);
  return { conversation, lead };
}
async function caseFor(businessId, conversationId, session = null) {
  const record = await RecoveryCase.findOne({business: businessId, conversation: conversationId, generation: 1}).session(session).lean();
  if (!record) throw contractError('Recovery record not initialized. Use Load recovery review.', 'RECOVERY_NOT_FOUND', 404);
  return record;
}
// This is a server-scoped adapter. Never take authoritative customer facts from a browser.
export async function initializeRecoveryCase({businessId,conversationId}) {
  requireCoordinatorEnabled(businessId);
  const {conversation,lead} = await linked(businessId,conversationId);
  const facts = normalizeFacts({customerName: /^(missed call lead|new sms lead|unknown|customer)$/i.test(lead.customerName||'') ? '' : lead.customerName || conversation.customerName,
    serviceNeeded: lead.serviceNeeded, address: lead.address, preferredAppointmentTime: lead.preferredAppointmentTime });
  try {
    return await RecoveryCase.findOneAndUpdate({business:businessId,conversation:conversation._id,generation:1},
      {$setOnInsert:{business:businessId,conversation:conversation._id,lead:lead._id,generation:1,version:0,
        status:conversation.serviceEligibility?.decision==='needs_staff_review' ? 'needs_review' : 'qualifying',facts,
        serviceDecision:{decision:'pending'},source:{leadUpdatedAt:lead.updatedAt,conversationUpdatedAt:conversation.updatedAt}}},
      {upsert:true,new:true,runValidators:true}).lean();
  } catch(error) {
    if(error.code===11000) return RecoveryCase.findOne({business:businessId,conversation:conversation._id,generation:1}).lean();
    throw error;
  }
}
export async function readRecoveryCase({businessId,conversationId}) {
  requireCoordinatorEnabled(businessId);
  const record = await caseFor(businessId,conversationId);
  const appointment = await Appointment.findOne({ business:businessId, lead:record.lead, conversation:record.conversation,
    status:{$in:['held','confirmed']} }).sort({createdAt:-1}).select('_id status startAt endAt serviceOffering confirmedAt').lean();
  const notification = appointment ? await AppointmentNotificationJob.findOne({business:businessId,appointment:appointment._id})
    .sort({createdAt:-1}).select('status key providerMessageId createdAt').lean() : null;
  return {case:record, appointment:appointment||null, notification:notification||null,
    capabilities:{factsEditable:writeThroughEnabled(),bookingDecisionEnforced:process.env.MEEKCALL_RECOVERY_REQUIRE_SERVICE_DECISION==='true'},
    note:'The appointment collection, not this recovery case, determines whether a booking is confirmed. Notification delivery is separately verified.'};
}
async function requireOwnedReview({businessId,conversationId,leadId,userId,session}) {
  const conversation = await Conversation.findOne({_id:conversationId,business:businessId,lead:leadId,humanTakeover:true}).session(session).lean();
  if (!conversation) throw conflict('Accept the request and pause AI before editing or deciding service eligibility.');
  // An unrelated safety or delivery exception does not grant service-approval rights.
  const alert = await Alert.findOne({business:businessId,conversation:conversationId,lead:leadId,
    actionRequired:true,resolvedAt:null,acknowledgedAt:{$ne:null},assignedTo:userId,
    $or:[{type:'human_requested',dedupeKey:/^(ai_review|human_handoff|request_review):/},
      {type:'system','metadata.serviceEligibilityReason':{$exists:true}},
      {type:'system','metadata.additionalRequest':{$exists:true}}]})
    .session(session).select('_id').lean();
  if (!alert) throw conflict('No active staff review exists; reconcile the review rather than bypassing it.');
  return conversation;
}
export async function applyRecoveryOperation({businessId,conversationId,userId,version,operationId,action,payload}) {
  requireCoordinatorEnabled(businessId);
  requiredVersion(version);operationKey(operationId);
  if (!isId(userId)) throw contractError('Authenticated user identity required.', 'RECOVERY_UNAUTHORIZED', 401);
  if (!['facts','decision'].includes(action)) throw contractError('Unsupported recovery action.');
  if (action==='facts' && !writeThroughEnabled()) throw contractError('Customer fact write-through is disabled for this pilot. No changes were made.', 'RECOVERY_FACTS_READ_ONLY', 409);
  const input = action === 'facts' ? validateFacts(payload) : validateDecision(payload);
  const operationHash = sha({businessId:str(businessId),conversationId:str(conversationId),action,input,version});
  let outcome;
  await mongoose.connection.transaction(async session => {
    const replay = await RecoveryEvent.findOne({business:businessId,operationId}).session(session).lean();
    if (replay) {
      if (replay.operationHash !== operationHash) throw conflict('An operation ID was reused for a different action.');
      outcome = await caseFor(businessId,conversationId,session);
      return;
    }
    const record = await caseFor(businessId,conversationId,session);
    if (record.version !== version) throw conflict('The customer request changed. Reload current facts before saving.');
    if (record.status === 'booked' || record.status === 'closed' || record.status === 'declined') throw conflict('This request is terminal; start a new reviewed customer request rather than rewriting history.');
    await requireOwnedReview({businessId,conversationId,leadId:record.lead,userId,session});
    let next = {}, evidence = {};
    if (action === 'facts') {
      // Write-through is optional and disabled by default. Canonical/staff state is
      // staged separately until the old and new APIs pass parity and crash tests.
      const fresh = await Lead.findOne({_id:record.lead,business:businessId}).session(session).lean();
      for (const key of Object.keys(input)) if (String(record.facts?.[key]||'') !== String(fresh?.[key]||''))
        throw conflict('Legacy lead changed after recovery snapshot. Refresh and reconcile facts before editing.');
      next.facts = {...record.facts,...input};
      next.status = 'needs_review';
      next.serviceDecision = {decision:'pending'}; // facts change invalidates previous approval
      evidence = {changedKeys:Object.keys(input)}; // do not replicate PII in audit log
      if (writeThroughEnabled()) {
        const updateLead = await Lead.updateOne({_id:record.lead,business:businessId},{$set:input},{session,runValidators:true});
        if (updateLead.matchedCount!==1) throw conflict('Linked lead was not found.');
        const memory = Object.fromEntries(Object.entries(input).filter(([key])=>key!=='customerName').map(([key,value])=>[`conversationMemory.${key}`,value]));
        const update = {...memory,...(input.customerName?{customerName:input.customerName}:{}),
          ...(input.serviceNeeded?{serviceEligibility:{decision:'needs_staff_review',reason:'staff_corrected_request',request:input.serviceNeeded}}:{})};
        await Conversation.updateOne({_id:conversationId,business:businessId},{$set:update},{session,runValidators:true});
      }
    } else {
      const old = record.facts?.serviceNeeded;
      const currentLead = await Lead.findOne({_id:record.lead,business:businessId}).session(session).lean();
      if (String(currentLead?.serviceNeeded||'').trim()!==String(old||'').trim()) throw conflict('The reviewed service differs from the saved lead. Reconcile facts before approving.');
      if (!old || !old.trim()) throw conflict('Correct the actual service request before deciding.');
      next.status = nextReviewState(record,input.decision);
      if (input.decision === 'accepted') {
        const offering = await ServiceOffering.findOne({_id:input.serviceOfferingId,business:businessId,active:true}).session(session).lean();
        if (!offering) throw conflict('The configured service offering is missing or inactive.');
        const policy = await evaluateServiceEligibility({businessId,request:old});
        // Fail closed: accepting ownership does not override exclusions, catalog
        // ambiguity, or a mismatched service offering. Existing booking checks stay.
        if (!['supported','needs_staff_review'].includes(policy.decision) || str(policy.serviceId)!==str(offering._id))
          throw contractError('Correct the service description or catalog matching before approval. Unsupported work cannot be authorized.', 'RECOVERY_SERVICE_NOT_ELIGIBLE',409);
      }
      next.serviceDecision = {decision:input.decision,serviceOfferingId:input.serviceOfferingId,
        requestFingerprint:fingerprintRequest(old),reason:input.reason,actor:userId,decidedAt:new Date()};
      evidence = {decision:input.decision,offeringId:input.serviceOfferingId||null};
    }
    const updated = await RecoveryCase.findOneAndUpdate({_id:record._id,business:businessId,version},
      {$set:next,$inc:{version:1}},{new:true,runValidators:true,session}).lean();
    if (!updated) throw conflict('Concurrent recovery update. Reload and try again.');
    await RecoveryEvent.create([{business:businessId,recoveryCase:record._id,conversation:record.conversation,
      operationId,operationHash,kind:action==='facts'?'facts_corrected':input.decision==='accepted'?'service_accepted':'service_declined',
      versionBefore:version,versionAfter:version+1,actor:userId,evidence}],{session});
    outcome = updated;
  });
  return outcome;
}
export async function listRecoveryEvents({businessId,conversationId,limit=30}) {
  requireCoordinatorEnabled(businessId);
  const record = await caseFor(businessId,conversationId);
  return RecoveryEvent.find({business:businessId,recoveryCase:record._id})
    .sort({createdAt:-1,_id:-1}).limit(Math.min(50,Math.max(1,Number(limit)||30)))
    .select('kind createdAt versionBefore versionAfter evidence').lean();
}
