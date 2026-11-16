import { persistStaffFollowUpLead, persistStaffFollowUpConversation } from '../stateTransitions/messaging.js';
import { handleSmsContactControl, handleSmsRequestInterrupt } from "./inboundSmsDeterministicActions.service.js";
import { createSmsOutboundDelivery } from './smsOutboundDelivery.adapter.js';
import { preserveHigherUrgency } from "./urgencyPolicy.service.js";
import { smsContactControlKind, canAcknowledgeSmsContactControl } from './smsContactControl.service.js';
import { handleAppointmentReply } from '../scheduling/appointmentReply.service.js';
import { captureTurnFacts } from '../booking/turnFactCapture.service.js';
import { guardServiceRequest } from '../serviceEligibility/serviceEligibility.service.js';
import { respectCustomerConstraints } from '../conversationCondition.service.js';
import { getApprovedServiceEstimate } from "../booking/approvedServiceEstimate.service.js";
import { confirmationTimingReply } from "../booking/recoveryIntake.service.js";
import { isConfirmationQuestion } from "../booking/conversationQuestions.service.js";
// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: processor
import { classifySmsIntent } from "./smsIntentClassifier.service.js";
import { loadCustomerTurn, completeCoalescedJobs } from "./smsTurnAggregation.service.js";
import Business from "../../models/business.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import Message from "../../models/message.js";
import { sendSms } from "../twilioSmsService.js";
import AlertService from "../alert.service.js";
import SocketService from "../socket.service.js";
import { logOperationalEvent, logOperationalError } from "../../helpers/logging/safeLogger.js";
import { evaluateDeterministicInboundGuardrails } from "../../helpers/ai/aiGuardrails.js";
import { isBusinessFeatureEnabled } from "../../helpers/businessFeatures.js";
import { isHumanHandoffSource } from "./smsHandoff.service.js";
import { applySmsProductionInvariants } from "./smsProductionInvariant.service.js";
import { getSmsAutomationSuppressionReason } from "./smsAutomationDispatchPolicy.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { describeSmsWorkflowDecision } from './smsWorkflowPolicy.service.js';
import { planCustomerTurn } from './customerTurnPlan.service.js';
import { routeConversationReply } from './inboundSmsReply.service.js';
const persistOutboundReply = createSmsOutboundDelivery({ Message, Conversation, AlertService, SocketService, sendSms, logOperationalEvent, applySmsProductionInvariants, describeSmsWorkflowDecision, assertDistributedLeaseActive, respectCustomerConstraints, getSmsAutomationSuppressionReason });

async function resolveSmsRecords(job) {
  const [business, inboundMessage, conversation, lead] = await Promise.all([
    Business.findById(job.business),
    Message.findOne({ _id: job.inboundMessage, business: job.business, conversation: job.conversation }),
    Conversation.findOne({ _id: job.conversation, business: job.business }),
    Lead.findOne({ _id: job.lead, business: job.business }),
  ]);

  if (!business || !inboundMessage || !conversation || !lead) {
    const error = new Error("SMS processing job references missing records");
    error.code = "SMS_JOB_RECORD_MISSING";
    throw error;
  }
  if (conversation.lead && String(conversation.lead) !== String(lead._id)) {
    throw Object.assign(new Error('SMS job references a different request'), { code: 'SMS_JOB_RECORD_MISMATCH' });
  }
  return { job, business, inboundMessage, conversation, lead };
}

// STOP, HELP and opt-in are consumed by the webhook before an automation job
// is queued. This stage only normalizes the durable, coalesced customer turn.
function loadNormalizedTurn({ conversation, inboundMessage }) {
  return loadCustomerTurn({ conversationId: conversation._id, anchorMessage: inboundMessage });
}

function completeTurn({ conversation, job, inboundMessage, customerTurn }) {
  return completeCoalescedJobs({
    conversationId: conversation._id,
    primaryJobId: job._id,
    primaryMessageId: inboundMessage._id,
    turnMessageIds: customerTurn.turnMessageIds,
  });
}

async function routeAppointmentReply(context) {
  const { business, conversation, inboundMessage, customerTurn } = context;
  const appointmentReply = await handleAppointmentReply({ business, conversation, inboundMessage, text: customerTurn.customerMessage });
  if (!appointmentReply?.handled) return null;
  await completeTurn(context);
  return { decision: 'appointment_reply', ...appointmentReply };
}

function planSmsRouting(context) {
  const { business, lead, conversation, inboundMessage, customerTurn } = context;
  const messages = customerTurn.historyMessages;
  const effectiveInboundMessage = customerTurn.primaryInboundMessage;
  const turnPlan = planCustomerTurn({ business, lead, conversation, customerMessage: customerTurn.customerMessage });
  const handoffSource = isHumanHandoffSource({
    conversation,
    inboundMessageId: inboundMessage._id,
  });
  return { ...context, messages, effectiveInboundMessage, turnPlan, handoffSource };
}

async function replayDurableHandoff(context) {
  const { business, inboundMessage, handoffSource } = context;
  /*
   * A worker can crash after persisting the provider result but before marking
   * the queue job complete. Treat the durable outbound record as authoritative
   * and complete the retry without generating or sending a duplicate message.
   */
  if (handoffSource) {
    const existingHandoffReply = await Message.findOne({
      business: business._id,
      inReplyToMessage: inboundMessage._id,
    });
    const hasDurableProviderOutcome = Boolean(
      existingHandoffReply?.providerMessageId ||
        existingHandoffReply?.deliveryUncertain === true ||
        existingHandoffReply?.status === "suppressed",
    );

    if (hasDurableProviderOutcome) {
      await completeTurn(context);
      return {
        decision: "human_handoff",
        messageCategory: "human_requested",
        outboundMessageId: existingHandoffReply?._id || null,
        sent: Boolean(existingHandoffReply?.providerMessageId),
        suppressed: existingHandoffReply?.status === "suppressed",
        duplicate: true,
      };
    }
  }
  return null;
}

function assessSmsTurn(context) {
  const { business, lead, conversation, customerTurn, messages } = context;
  /*
   * Staff ownership never restarts AI. Explicit contact requests and receipt
   * checks use the deterministic, persistence-first control route below.
   * Receipt acknowledgements are throttled independently of callback requests.
   */
  const classification = classifySmsIntent({
    customerMessage: customerTurn.customerMessage,
    business,
    conversation,
    lead,
  });
  const deterministicAssessment = evaluateDeterministicInboundGuardrails({
    customerMessage: customerTurn.customerMessage,
    recentMessages: messages,
    activityWindowStartAt:
      conversation?.orchestration?.recoveryJourneyStartedAt || null,
  });
  const safetyReviewRequired = deterministicAssessment.handled &&
    (["emergency", "hazardous_diy_request"].includes(deterministicAssessment.category) ||
      deterministicAssessment.reason === "safety_clarification_required");
  const automationPaused = conversation.humanTakeover === true || conversation.aiEnabled === false ||
    ["closed", "archived"].includes(conversation.status);
  return { ...context, classification, deterministicAssessment, safetyReviewRequired, automationPaused };
}

async function routeSmsContactControl(context) {
  const { business, lead, conversation, inboundMessage, customerTurn, job, deterministicAssessment } = context;
  // Safety evidence still updates the staff queue; it cannot resume automation.
  const contactKind = smsContactControlKind(customerTurn.customerMessage);
  // This route precedes both completed intake and staff ownership suppression.
  // Mixed factual/booking turns stay with the existing orchestration below.
  if (contactKind && !deterministicAssessment.handled && canAcknowledgeSmsContactControl(conversation)) {
    return handleSmsContactControl({
      business, lead, conversation, inboundMessage, customerTurn, contactKind, job, persistOutboundReply,
    });
  }
  return null;
}

async function routeRequestInterrupt(context) {
  const { business, lead, conversation, inboundMessage, customerTurn, job, messages,
    classification, turnPlan, handoffSource, deterministicAssessment, automationPaused } = context;
  if (deterministicAssessment.handled || automationPaused || turnPlan.compound) return null;
  const interrupt = await handleSmsRequestInterrupt({
    business, lead, conversation, inboundMessage, customerTurn, job, messages,
    classification, turnPlan, handoffSource, persistOutboundReply,
  });
  if (interrupt) return interrupt;
  return routeServiceEligibility(context);
}

async function routeServiceEligibility(context) {
  const { business, lead, conversation, inboundMessage, customerTurn } = context;
  const eligibilityResult = await guardServiceRequest({ business, lead, conversation,
    customerMessage: customerTurn.customerMessage, turnId: String(inboundMessage._id) });
  if (eligibilityResult) {
    const delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage, result: eligibilityResult });
    SocketService.emitLeadUpdated(business._id, lead);
    SocketService.emitConversationUpdated(business._id, conversation);
    await completeTurn(context);
    return { decision: eligibilityResult.decision, reason: eligibilityResult.serviceEligibility?.reason || eligibilityResult.guardrail?.reason,
      sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
  }
  return null;
}

function shouldKeepStaffOwnership({ conversation, classification, handoffSource, turnPlan, automationPaused, safetyReviewRequired }) {
  // Completed manual intake stays in the staff queue, including safety reviews
  // that cannot resume automation.
  return (conversation?.orchestration?.handoffReason === "intake_complete" && !handoffSource && !turnPlan.compound &&
    !classification.intents?.human && !classification.intents?.callback) ||
    (automationPaused && safetyReviewRequired);
}

async function persistStaffFollowUp(context) {
  const { business, lead, conversation, inboundMessage, customerTurn,
    classification, deterministicAssessment, automationPaused, safetyReviewRequired: safety } = context;
  // This branch bypasses the ordinary AI result persistence. Preserve facts
  // and raise urgency before creating the durable staff task or replying.
  const urgency = preserveHigherUrgency(lead.urgency,
    safety ? (deterministicAssessment.category === "emergency" ? "emergency" : "high") : classification.entities?.urgency);
  assertDistributedLeaseActive();
  const facts = safety ? captureTurnFacts({ customerMessage: customerTurn.customerMessage, classification, business, lead }) : {};
  const followUpLead = await persistStaffFollowUpLead({ Lead, facts, lead, urgency });
  Object.assign(lead, facts, { urgency });
  const intent = safety ? deterministicAssessment.category : "intake_follow_up";
  const followUpConversation = await persistStaffFollowUpConversation({ Conversation, conversation, inboundMessage, intent, urgency });
  await Message.findByIdAndUpdate(inboundMessage._id, { $set: {
    aiOutcome: { intent, urgency, serviceNeeded: lead.serviceNeeded || "",
      address: lead.address || "", preferredAppointmentTime: lead.preferredAppointmentTime || "",
      bookingState: conversation.bookingState?.status || "not_started",
      outcome: "queued_for_team", confidence: safety ? 100 : 0 },
  } });
  SocketService.emitLeadUpdated(business._id, followUpLead);
  SocketService.emitConversationUpdated(business._id, followUpConversation);
  await AlertService.createHumanHandoffAlert({
    businessId: business._id, leadId: lead._id, conversationId: conversation._id,
    messageId: inboundMessage._id, providerMessageId: inboundMessage.providerMessageId,
    customerName: lead.customerName, customerPhone: conversation.customerPhone,
    customerMessage: customerTurn.customerMessage, lead,
    result: {
      messageCategory: safety ? deterministicAssessment.category : "service_request",
      urgency,
      summary: safety ? "New customer safety concern; review the full conversation." : "Additional customer message after completed intake; review the full conversation.",
      handoff: { reason: automationPaused ? "staff_safety_review" : "intake_follow_up", callbackRequested: false },
      riskFlags: safety ? (deterministicAssessment.riskFlags || ["safety_hazard"]) : [],
    },
  });
  const delivery = await deliverStaffFollowUp({ ...context, safety });
  await completeTurn(context);
  return { decision: "queued_for_team", reason: automationPaused ? "staff_safety_review" : "intake_complete",
    sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
}

async function deliverStaffFollowUp({ business, lead, conversation, inboundMessage, customerTurn,
  classification, deterministicAssessment, automationPaused, safety }) {
  let delivery = { sent: false };
  // A fixed emergency response does not resume AI or relinquish staff ownership.
  // Existing inbound-reply idempotency and SMS consent/budgets still apply.
  if (safety && (!automationPaused || deterministicAssessment.category === "emergency")) {
    delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage,
      result: { decision: "send_fixed_response", actionType: "send_fixed_response", messageCategory: deterministicAssessment.category, reply: deterministicAssessment.reply, guardrail: { skipAI: true } },
    });
  }
  if (!safety && classification.intents?.pricing && !automationPaused) {
    let estimate = "";
    const changedRequest = classification.intents?.correction || classification.intents?.newService ||
      (classification.entities?.serviceNeeded && classification.entities.serviceNeeded !== lead.serviceNeeded);
    try {
      if (!changedRequest) estimate = await getApprovedServiceEstimate({ businessId: business._id,
        serviceNeeded: lead.serviceNeeded, customerMessage: customerTurn.customerMessage });
    } catch (error) { logOperationalError("sms.approved_price_lookup_failed", error, { businessId: business._id }); }
    delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage,
      result: { decision: "send_fixed_response", actionType: "send_fixed_response", messageCategory: "pricing_request",
        reply: estimate || "I don't have an approved estimate for that request. Your pricing question is saved for business review; the requested appointment remains unconfirmed.",
        guardrail: { skipAI: true } },
    });
  }
  if (!safety && !classification.intents?.pricing && isConfirmationQuestion(customerTurn.customerMessage) && !automationPaused) {
    delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage,
      result: { decision: "send_fixed_response", actionType: "send_fixed_response", messageCategory: "appointment_status", reply: confirmationTimingReply({ lead }), guardrail: { skipAI: true } },
    });
  }
  return delivery;
}

async function skipIneligibleAutomation(context) {
  const { business, conversation, deterministicAssessment } = context;
  const aiQualificationEnabled = isBusinessFeatureEnabled(
    business,
    "aiQualificationEnabled",
  );
  const automationEligible =
    conversation.aiEnabled !== false &&
    conversation.humanTakeover !== true &&
    conversation.status !== "closed" &&
    conversation.status !== "archived";
  const mayProcessAI =
    automationEligible &&
    (deterministicAssessment.handled || aiQualificationEnabled);

  if (!mayProcessAI) {
    logOperationalEvent("twilio.sms.ai_skipped", {
      businessId: business._id,
      conversationId: conversation._id,
      aiEnabled: conversation.aiEnabled,
      humanTakeover: conversation.humanTakeover,
      conversationStatus: conversation.status,
      handoffStatus: conversation?.orchestration?.handoffStatus || "",
      aiQualificationEnabled,
      deterministicHandled: deterministicAssessment.handled,
    });
    await completeTurn(context);
    return { decision: "skipped", reason: "ai_ineligible" };
  }
  return null;
}

export const processInboundSmsJob = async (job) => {
  const records = await resolveSmsRecords(job);
  const turn = { ...records, customerTurn: await loadNormalizedTurn(records) };
  const appointmentReply = await routeAppointmentReply(turn);
  if (appointmentReply) return appointmentReply;

  const routing = planSmsRouting(turn);
  const existingHandoff = await replayDurableHandoff(routing);
  if (existingHandoff) return existingHandoff;

  const context = assessSmsTurn(routing);
  const controlReply = await routeSmsContactControl(context);
  if (controlReply) return controlReply;
  if (context.automationPaused && !context.safetyReviewRequired) {
    await completeTurn(context);
    return { decision: "skipped", reason: "ai_ineligible" };
  }

  const interrupt = await routeRequestInterrupt(context);
  if (interrupt) return interrupt;
  if (shouldKeepStaffOwnership(context)) return persistStaffFollowUp(context);
  return (await skipIneligibleAutomation(context)) || routeConversationReply(context, { persistOutboundReply, completeTurn });
};

export const safelyProcessInboundSmsJob = async (job) => {
  try {
    return await processInboundSmsJob(job);
  } catch (error) {
    logOperationalError("sms.processing_job.failed", error, {
      jobId: job?._id,
      businessId: job?.business,
      inboundMessageId: job?.inboundMessage,
    });
    throw error;
  }
};

export default { processInboundSmsJob, safelyProcessInboundSmsJob };
