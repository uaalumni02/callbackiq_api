import { persistSmsContactControl, persistSmsTakeoverControl, persistInterruptedLeadRequest, persistInterruptedConversationRequest } from '../stateTransitions/messaging.js';
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import Message from "../../models/message.js";
import AlertService from "../alert.service.js";
import SocketService from "../socket.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { handleConversationControl, isRequestWithdrawal } from "../conversationControl.service.js";
import { handleRecoveryIntake } from "../booking/recoveryIntake.service.js";
import { buildLeadUpdates } from "./inboundLeadProjection.service.js";
import { contactControlReply } from "./smsContactControl.service.js";
import { shouldSendHumanHandoffStatusAcknowledgement } from "./smsHandoff.service.js";
import { buildSmsStatePatch } from "./smsConversationState.service.js";
import { buildSmsRequestRevisionPatch, preserveSmsInterruptFacts, reviewSmsAppointmentRevision } from "./smsWorkflowPolicy.service.js";
import { completeCoalescedJobs } from "./smsTurnAggregation.service.js";
export async function handleSmsContactControl({
  business, lead, conversation, inboundMessage, customerTurn, contactKind, job, persistOutboundReply,
}) {
  const state = conversation.conversationMemory?.recoveryIntake?.contactControl || {};
  const priorReceipt = state.receiptReply;
  const replay = String(priorReceipt?.inboundMessageId || '') === String(inboundMessage._id);
  if (contactKind === 'receipt' && !replay && !shouldSendHumanHandoffStatusAcknowledgement({
    conversation: { orchestration: { handoffStatusReplyAt: priorReceipt?.at } },
  })) {
    await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id,
      primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
    return { decision: 'skipped', reason: 'human_handoff_status_throttled' };
  }
  const requested = contactKind !== 'receipt';
  if (requested) {
    assertDistributedLeaseActive();
    const saved = await AlertService.createHumanHandoffAlert({
      businessId: business._id, leadId: lead._id, conversationId: conversation._id,
      messageId: inboundMessage._id, providerMessageId: inboundMessage.providerMessageId,
      customerName: lead.customerName, customerPhone: conversation.customerPhone,
      customerMessage: customerTurn.customerMessage, lead,
      result: { messageCategory: 'human_requested', urgency: lead.urgency,
        handoff: { required: true, reason: 'human_requested', callbackRequested: contactKind === 'callback',
          callbackPhone: conversation.customerPhone } },
    });
    if (!saved?.alert?._id) throw Object.assign(new Error('Staff contact request was not saved.'), { code: 'STAFF_ACTION_NOT_SAVED' });
    assertDistributedLeaseActive();
    const updated = await persistSmsContactControl({ Conversation, contactKind, conversation, inboundMessage, saved });
    if (!updated) throw Object.assign(new Error('Staff contact request projection was not saved.'), { code: 'STAFF_ACTION_NOT_SAVED' });
    SocketService.emitConversationUpdated(business._id, updated);
  }
  const result = { decision: 'send_fixed_response', actionType: 'human_handoff_status',
    messageCategory: requested ? 'human_requested' : 'human_handoff_status', contactControl: contactKind,
    reply: contactControlReply({ kind: contactKind, conversation, savedRequest: requested }),
    guardrail: { skipAI: true, reason: 'sms_contact_control' },
    handoff: { required: requested, statusAcknowledgement: !requested } };
  const delivery = await persistOutboundReply({ business, lead, conversation,
    inboundMessage: { ...(inboundMessage.toObject?.() || inboundMessage), body: customerTurn.customerMessage }, result });
  // Only an accepted send starts throttling. Same-message retries still reach
  // outbound idempotency, including retries after provider acceptance.
  if (contactKind === 'receipt' && delivery.sent === true) {
    assertDistributedLeaseActive();
    await persistSmsTakeoverControl({ Conversation, conversation, inboundMessage });
  }
  if (!delivery.sent && !delivery.suppressed && delivery.reason !== 'delivery_uncertain') {
    throw Object.assign(new Error('Contact acknowledgement has no durable delivery outcome.'), { code: 'SMS_HANDOFF_ACK_REQUIRED' });
  }
  await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id,
    primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
  return { decision: 'contact_control', messageCategory: result.messageCategory,
    sent: delivery.sent === true, suppressed: delivery.suppressed === true,
    outboundMessageId: delivery.message?._id || null };
}

export async function handleSmsRequestInterrupt({
  business, lead, conversation, inboundMessage, customerTurn, job, messages,
  classification, turnPlan, handoffSource, persistOutboundReply,
}) {
  const params = { business, lead, conversation, customerMessage: customerTurn.customerMessage,
    turnId: String(inboundMessage._id), recentMessages: messages };
  const changedService = !isRequestWithdrawal(customerTurn.customerMessage) && classification.entities?.serviceNeeded &&
    (classification.intents?.correction || classification.intents?.newService);
  const control = changedService || turnPlan.additionalRequest ? null : await handleConversationControl(params);
  const reviewUpdate = !control && conversation?.orchestration?.handoffReason === "intake_complete" && !handoffSource
    ? await handleRecoveryIntake({ ...params, reviewOnly: true }) : null;
  const directResult = reviewSmsAppointmentRevision({ lead, conversation,
    result: preserveSmsInterruptFacts({ result: control || reviewUpdate,
      customerMessage: customerTurn.customerMessage, business, lead, conversation }) });
  if (directResult) {
    const revisionPatch = buildSmsRequestRevisionPatch({ result: directResult, lead, conversation });
    const interruptUpdates = buildLeadUpdates(lead, directResult);
    const refreshedLead = await persistInterruptedLeadRequest({ Lead, interruptUpdates, lead });
    if (refreshedLead) Object.assign(lead, typeof refreshedLead.toObject === 'function' ? refreshedLead.toObject() : refreshedLead);
    await persistInterruptedConversationRequest({ Conversation, buildSmsStatePatch, classification, conversation, directResult, revisionPatch });
    if (directResult.handoff?.required === true || (Object.keys(revisionPatch).length && conversation.bookingState?.appointment)) {
      await AlertService.createHumanHandoffAlert({ businessId: business._id, leadId: lead._id, conversationId: conversation._id,
        messageId: inboundMessage._id, providerMessageId: inboundMessage.providerMessageId,
        customerPhone: conversation.customerPhone, customerMessage: customerTurn.customerMessage, lead,
        result: { ...directResult, handoff: directResult.handoff?.required ? directResult.handoff : { required: true, reason: 'scheduling_review' } } });
    }
    const delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage, result: directResult });
    await Message.findByIdAndUpdate(inboundMessage._id, { $set: { aiOutcome: {
      intent: directResult.messageCategory, outcome: "reply_ready", serviceNeeded: lead.serviceNeeded || "",
      address: lead.address || "", urgency: lead.urgency || "medium",
    } } });
    SocketService.emitLeadUpdated(business._id, lead);
    SocketService.emitConversationUpdated(business._id, conversation);
    await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id,
      primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
    return { decision: directResult.decision, messageCategory: directResult.messageCategory,
      sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
  }
  return null;
}
