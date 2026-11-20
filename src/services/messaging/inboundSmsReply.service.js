import { persistLeadReplyFacts } from './inboundReplyLeadFacts.service.js';
import { persistReplyConversationState, linkReplyReview, persistFailedHandoffDelivery, finalizeAcknowledgedHandoff } from '../stateTransitions/messaging.js';
import { beginValuation } from "../valuation/opportunityValuation.service.js";
import { buildSmsStatePatch } from "./smsConversationState.service.js";
import ConversationOrchestratorService from "../conversationOrchestrator.service.js";
import Conversation from "../../models/conversation.js";
import AlertService from "../alert.service.js";
import SocketService from "../socket.service.js";
import { logOperationalEvent } from "../../helpers/logging/safeLogger.js";
import {
  buildCompletedIntakeResult,
  shouldCompleteManualIntake,
  buildFailedHumanHandoffUpdate,
  buildFinalizedHumanHandoffUpdate,
  buildPendingHumanHandoffUpdate,
  ensureHumanHandoffResult,
  ensureUrgentOperationalResult,
  isUrgentOperationalResult,
  requiresHumanHandoff,
} from "./smsHandoff.service.js";
import { applySmsProductionInvariants } from "./smsProductionInvariant.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { buildSmsRequestRevisionPatch, reviewSmsAppointmentRevision } from "./smsWorkflowPolicy.service.js";
async function prepareConversationReply({ business, lead, conversation, messages, effectiveInboundMessage, handoffSource, customerTurn }) {
  const valuationTicket = await beginValuation(lead, business._id);
  const retryingCompletedIntake = handoffSource && conversation?.orchestration?.handoffReason === "intake_complete";
  const orchestration = retryingCompletedIntake
    ? { result: buildCompletedIntakeResult({ business, result: conversation.conversationMemory?.recoveryIntake?.preparedHandoffResult || { messageCategory: "service_request", serviceNeeded: lead.serviceNeeded, urgency: lead.urgency, address: lead.address, preferredAppointmentTime: lead.preferredAppointmentTime, summary: lead.summary } }), outcome: { intent: "service_request", outcome: "reply_ready" } }
    : await ConversationOrchestratorService.process({
        business, lead, conversation, messages, inboundMessage: effectiveInboundMessage,
      });
  let result = reviewSmsAppointmentRevision({ result: orchestration.result || {}, lead, conversation });
  result = applySmsProductionInvariants({
    result, business, lead, conversation,
    customerMessage: customerTurn.customerMessage,
  });
  assertDistributedLeaseActive();
  let handoffRequired = requiresHumanHandoff(result);
  const urgentOperational = isUrgentOperationalResult(result);

  if (handoffRequired) {
    result = ensureHumanHandoffResult({
      result,
      business,
      lead,
      conversation,
      customerMessage: customerTurn.customerMessage,
    });
  } else if (urgentOperational) {
    result = ensureUrgentOperationalResult({
      result,
      business,
      lead,
      conversation,
      customerMessage: customerTurn.customerMessage,
    });
  }

  return { orchestration, valuationTicket, result, handoffRequired };
}



async function persistConversationReplyState(context, reply, updatedLead, revisionPatch) {
  const { business, conversation, classification, inboundMessage, customerTurn } = context;
  const { orchestration } = reply;
  let { result, handoffRequired } = reply;
  let updatedConversation = conversation;
  if (!handoffRequired && shouldCompleteManualIntake({ business, lead: updatedLead, conversation: updatedConversation, result })) {
    result = ensureHumanHandoffResult({
      result: buildCompletedIntakeResult({ result, business }),
      business, lead: updatedLead, conversation: updatedConversation,
      customerMessage: customerTurn.customerMessage,
    });
    handoffRequired = true;
  }

  const statePatch = buildSmsStatePatch({
    conversation: updatedConversation,
    classification,
    outcome: orchestration.outcome,
    now: new Date(),
    hasCustomerReply: true,
  });
  const pendingHandoffPatch = handoffRequired
    ? buildPendingHumanHandoffUpdate({
        inboundMessageId: inboundMessage._id,
        conversation: updatedConversation,
        result,
      })
    : {};

  assertDistributedLeaseActive();
  updatedConversation = await persistReplyConversationState({ Conversation, handoffRequired, pendingHandoffPatch, result, revisionPatch, statePatch, updatedConversation });
  SocketService.emitConversationUpdated(business._id, updatedConversation);
  return { result, handoffRequired, updatedLead, updatedConversation };
}

async function persistConversationReview({ business, inboundMessage, customerTurn }, reply) {
  const { result, handoffRequired, updatedLead } = reply;
  let { updatedConversation } = reply;
  if (handoffRequired) {
    const savedReview = await AlertService.createHumanHandoffAlert({
      businessId: business._id,
      leadId: updatedLead._id,
      conversationId: updatedConversation._id,
      messageId: inboundMessage._id,
      providerMessageId: inboundMessage.providerMessageId,
      customerName: updatedLead.customerName,
      customerPhone: updatedConversation.customerPhone,
      customerMessage: customerTurn.customerMessage,
      result,
      lead: updatedLead,
    });
    if (!savedReview?.alert?._id) throw Object.assign(new Error('Staff review was not saved.'), { code: 'STAFF_ACTION_NOT_SAVED' });
    assertDistributedLeaseActive();
    const reviewPatch = {
      'conversationMemory.recoveryIntake.review': { status: 'queued', alertId: String(savedReview.alert._id),
        queuedAt: new Date(), evidenceKey: updatedConversation.conversationMemory?.recoveryIntake?.readiness?.evidenceKey || '' },
    };
    updatedConversation = await linkReplyReview({ Conversation, reviewPatch, updatedConversation });
    if (!updatedConversation) throw Object.assign(new Error('Review conversation was not persisted.'), { code: 'STAFF_ACTION_NOT_SAVED' });
    SocketService.emitConversationUpdated(business._id, updatedConversation);
  } else if (result?.shouldAlertOwner === true) {
    await AlertService.createAIReviewAlert({
      businessId: business._id,
      leadId: updatedLead._id,
      conversationId: updatedConversation._id,
      messageId: inboundMessage._id,
      providerMessageId: inboundMessage.providerMessageId,
      customerName: updatedLead.customerName,
      customerPhone: updatedConversation.customerPhone,
      result,
    });
  }
  return updatedConversation;
}

async function deliverConversationReply(persistOutboundReply, { business, inboundMessage }, { result, handoffRequired, updatedLead, updatedConversation }) {
  let delivery;
  try {
    delivery = await persistOutboundReply({
      business,
      lead: updatedLead,
      conversation: updatedConversation,
      inboundMessage,
      result,
    });

    if (
      handoffRequired &&
      delivery?.sent !== true &&
      delivery?.suppressed !== true &&
      delivery?.reason !== "delivery_uncertain"
    ) {
      const error = new Error(
        "Human handoff acknowledgement did not produce a durable provider outcome",
      );
      error.code = "SMS_HANDOFF_ACK_REQUIRED";
      throw error;
    }
  } catch (error) {
    if (handoffRequired) await persistHandoffDeliveryFailure({ business, inboundMessage, updatedConversation, result, error });
    throw error;
  }
  return delivery;
}

async function persistHandoffDeliveryFailure({ business, inboundMessage, updatedConversation, result, error }) {
  const latestConversation =
    (await Conversation.findById(updatedConversation._id)) ||
    updatedConversation;
  const failedConversation = await persistFailedHandoffDelivery({ Conversation, buildFailedHumanHandoffUpdate, error, inboundMessage, latestConversation, result, updatedConversation });
  SocketService.emitConversationUpdated(business._id, failedConversation);
  await AlertService.createSystemAlert({
    businessId: business._id,
    title: "Human handoff acknowledgement failed",
    message:
      "MeekCall could not confirm the customer handoff SMS. The queue will retry; review this conversation immediately.",
    priority: "critical",
    metadata: {
      conversationId: String(updatedConversation._id),
      inboundMessageId: String(inboundMessage._id),
      errorCode: String(error?.code || "SMS_HANDOFF_DELIVERY_FAILED"),
    },
    dedupeKey: `sms_handoff_delivery_failed:${inboundMessage._id}`,
  });
}

async function finalizeConversationHandoff({ business, inboundMessage }, { result, updatedConversation }, delivery) {
  const deliveryStatus = delivery?.sent
    ? "acknowledged"
    : delivery?.suppressed
      ? "suppressed"
      : "delivery_uncertain";
  const latestConversation =
    (await Conversation.findById(updatedConversation._id)) ||
    updatedConversation;
  updatedConversation = await finalizeAcknowledgedHandoff({ Conversation, buildFinalizedHumanHandoffUpdate, delivery, deliveryStatus, inboundMessage, latestConversation, result, updatedConversation });
  SocketService.emitConversationUpdated(business._id, updatedConversation);
  SocketService.emitDashboardRefresh(business._id, "sms_handoff_pending");
  logOperationalEvent("twilio.sms.handoff_pending", {
    businessId: business._id,
    conversationId: updatedConversation._id,
    inboundMessageId: inboundMessage._id,
    outboundMessageId: delivery?.message?._id || null,
    deliveryStatus,
  });
  return updatedConversation;
}

export async function routeConversationReply(context, { persistOutboundReply, completeTurn }) {
  const prepared = await prepareConversationReply(context);
  const revisionPatch = buildSmsRequestRevisionPatch({ result: prepared.result, lead: context.lead, conversation: context.conversation });
  const updatedLead = await persistLeadReplyFacts(context, prepared.result, prepared.valuationTicket);
  const reply = await persistConversationReplyState(context, prepared, updatedLead, revisionPatch);
  reply.updatedConversation = await persistConversationReview(context, reply);
  const delivery = await deliverConversationReply(persistOutboundReply, context, reply);
  if (reply.handoffRequired) reply.updatedConversation = await finalizeConversationHandoff(context, reply, delivery);
  await completeTurn({ ...context, conversation: reply.updatedConversation });

  const { result, handoffRequired, updatedConversation } = reply;
  return {
    decision: result?.decision || "reply",
    messageCategory: result?.messageCategory || "unknown",
    outboundMessageId: delivery?.message?._id || null,
    sent: delivery?.sent === true,
    suppressed: delivery?.suppressed === true,
    handoffStatus: handoffRequired
      ? updatedConversation?.orchestration?.handoffStatus || ""
      : "",
  };
}
