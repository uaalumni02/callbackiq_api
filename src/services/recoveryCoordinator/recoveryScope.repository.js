/** Tenant-scoped recovery reads and staff-authorization queries.
 * Extracted source-exact from recoveryCoordinator.service.js.
 * This module is not an alternative workflow owner.
 */
import mongoose from 'mongoose';
import RecoveryCase from '../../models/recoveryCase.js';
import Conversation from '../../models/conversation.js';
import Lead from '../../models/lead.js';
import Alert from '../../models/alert.js';
import { contractError } from './contract.js';

const str = value => String(value?._id || value || '');
const isId = value => mongoose.isObjectIdOrHexString(str(value));
const conflict = message => contractError(message, 'RECOVERY_CONFLICT', 409);

export async function linked(businessId, conversationId, session = null) {
  if (!isId(conversationId)) throw contractError('Invalid conversation ID.');
  const conversation = await Conversation.findOne({ _id: conversationId, business: businessId }).session(session).lean();
  if (!conversation || !isId(conversation.lead)) throw contractError('Active conversation and linked lead required.', 'RECOVERY_NOT_FOUND', 404);
  const lead = await Lead.findOne({ _id: conversation.lead, business: businessId }).session(session).lean();
  if (!lead) throw contractError('Lead does not belong to this business.', 'RECOVERY_NOT_FOUND', 404);
  return { conversation, lead };
}
export async function caseFor(businessId, conversationId, session = null) {
  const record = await RecoveryCase.findOne({business: businessId, conversation: conversationId, generation: 1}).session(session).lean();
  if (!record) throw contractError('Recovery record not initialized. Use Load recovery review.', 'RECOVERY_NOT_FOUND', 404);
  return record;
}

export async function requireOwnedReview({businessId,conversationId,leadId,userId,session}) {
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
