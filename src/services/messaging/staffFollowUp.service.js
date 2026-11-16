import { persistStaffFollowUpLead, persistStaffFollowUpConversation } from '../stateTransitions/messaging.js';
import Lead from '../../models/lead.js';
import Conversation from '../../models/conversation.js';
import Message from '../../models/message.js';
import SocketService from '../socket.service.js';
import AlertService from '../alert.service.js';
import { preserveHigherUrgency } from './urgencyPolicy.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { captureTurnFacts } from '../booking/turnFactCapture.service.js';
import { getApprovedServiceEstimate } from '../booking/approvedServiceEstimate.service.js';
import { confirmationTimingReply } from '../booking/recoveryIntake.service.js';
import { isConfirmationQuestion } from '../booking/conversationQuestions.service.js';
import { logOperationalError } from '../../helpers/logging/safeLogger.js';
export async function persistStaffFollowUp(context, { persistOutboundReply, completeTurn }) {
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
  const delivery = await deliverStaffFollowUp({ ...context, safety }, persistOutboundReply);
  await completeTurn(context);
  return { decision: "queued_for_team", reason: automationPaused ? "staff_safety_review" : "intake_complete",
    sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
}

async function deliverStaffFollowUp({ business, lead, conversation, inboundMessage, customerTurn,
  classification, deterministicAssessment, automationPaused, safety }, persistOutboundReply) {
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
