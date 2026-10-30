import { createSmsMessageReader } from './smsMessageRead.adapter.js';
import { createSmsOutboundDelivery } from './smsOutboundDelivery.adapter.js';
import {buildLeadUpdates} from './inboundLeadProjection.service.js';
import { VALID_URGENCIES, SMS_URGENCY_RANK, preserveHigherUrgency } from "./urgencyPolicy.service.js";
import { smsContactControlKind, canAcknowledgeSmsContactControl, contactControlReply } from './smsContactControl.service.js';
import { handleAppointmentReply } from '../scheduling/appointmentReply.service.js';
import { captureTurnFacts } from '../booking/turnFactCapture.service.js';
import { handleConversationControl, isRequestWithdrawal } from '../conversationControl.service.js';
import { guardServiceRequest, blocksServiceAutomation } from '../serviceEligibility/serviceEligibility.service.js';
import { respectCustomerConstraints } from '../conversationCondition.service.js';
import { getApprovedServiceEstimate } from "../booking/approvedServiceEstimate.service.js";
import { confirmationTimingReply, handleRecoveryIntake } from "../booking/recoveryIntake.service.js";
import { isConfirmationQuestion } from "../booking/conversationQuestions.service.js";
import { beginValuation, finishValuation } from "../valuation/opportunityValuation.service.js";
// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: processor
import { classifySmsIntent } from "./smsIntentClassifier.service.js";
import { buildSmsStatePatch } from "./smsConversationState.service.js";
import { loadCustomerTurn, completeCoalescedJobs } from "./smsTurnAggregation.service.js";
import Business from "../../models/business.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import Message from "../../models/message.js";
import Db from "../../db/db.js";
import ConversationOrchestratorService from "../conversationOrchestrator.service.js";
import { sendSms } from "../twilioSmsService.js";
import AlertService from "../alert.service.js";
import SocketService from "../socket.service.js";
import { logOperationalEvent, logOperationalError } from "../../helpers/logging/safeLogger.js";
import { evaluateDeterministicInboundGuardrails } from "../../helpers/ai/aiGuardrails.js";
import { isBusinessFeatureEnabled } from "../../helpers/businessFeatures.js";
import {
  buildCompletedIntakeResult,
  shouldCompleteManualIntake,
  buildFailedHumanHandoffUpdate,
  buildFinalizedHumanHandoffUpdate,
  buildPendingHumanHandoffUpdate,
  ensureHumanHandoffResult,
  ensureUrgentOperationalResult,
  isHumanHandoffSource,
  isUrgentOperationalResult,
  requiresHumanHandoff,
  shouldSendHumanHandoffStatusAcknowledgement,
} from "./smsHandoff.service.js";
import { applySmsProductionInvariants } from "./smsProductionInvariant.service.js";
import { getSmsAutomationSuppressionReason } from "./smsAutomationDispatchPolicy.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { describeSmsWorkflowDecision, preserveSmsInterruptFacts, buildSmsRequestRevisionPatch, reviewSmsAppointmentRevision } from './smsWorkflowPolicy.service.js';
import { planCustomerTurn } from './customerTurnPlan.service.js';

const getMessagesForReply = createSmsMessageReader({ Db, Message });

const persistOutboundReply = createSmsOutboundDelivery({ Message, Conversation, AlertService, SocketService, sendSms, logOperationalEvent, applySmsProductionInvariants, describeSmsWorkflowDecision, assertDistributedLeaseActive, respectCustomerConstraints, getSmsAutomationSuppressionReason });

export const processInboundSmsJob = async (job) => {
  const [business, inboundMessage, conversation, lead] = await Promise.all([
    Business.findById(job.business),
    Message.findById(job.inboundMessage),
    Conversation.findById(job.conversation),
    Lead.findById(job.lead),
  ]);

  if (!business || !inboundMessage || !conversation || !lead) {
    const error = new Error("SMS processing job references missing records");
    error.code = "SMS_JOB_RECORD_MISSING";
    throw error;
  }

  const customerTurn = await loadCustomerTurn({
    conversationId: conversation._id,
    anchorMessage: inboundMessage,
  });
  const appointmentReply = await handleAppointmentReply({ business, conversation, inboundMessage, text: customerTurn.customerMessage });
  if (appointmentReply?.handled) {
    await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id,
      primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
    return { decision: 'appointment_reply', ...appointmentReply };
  }
  const messages = customerTurn.historyMessages;
  const effectiveInboundMessage = customerTurn.primaryInboundMessage;
  const turnPlan = planCustomerTurn({ business, lead, conversation, customerMessage: customerTurn.customerMessage });
  const handoffSource = isHumanHandoffSource({
    conversation,
    inboundMessageId: inboundMessage._id,
  });

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
      await completeCoalescedJobs({
        conversationId: conversation._id,
        primaryJobId: job._id,
        primaryMessageId: inboundMessage._id,
        turnMessageIds: customerTurn.turnMessageIds,
      });
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
  // Safety evidence still updates the staff queue; it cannot resume automation.
  const contactKind = smsContactControlKind(customerTurn.customerMessage);
  // This route precedes both completed intake and staff ownership suppression.
  // Mixed factual/booking turns stay with the existing orchestration below.
  if (contactKind && !deterministicAssessment.handled && canAcknowledgeSmsContactControl(conversation)) {
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
      const updated = await Conversation.findByIdAndUpdate(conversation._id, { $set: {
        'conversationMemory.recoveryIntake.contactControl.request': {
          kind: contactKind, alertId: String(saved.alert._id), inboundMessageId: String(inboundMessage._id),
          requestedAt: new Date(), callbackPhone: conversation.customerPhone,
        },
      } }, { returnDocument: 'after', runValidators: true });
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
      await Conversation.findByIdAndUpdate(conversation._id, { $set: {
        'conversationMemory.recoveryIntake.contactControl.receiptReply': {
          at: new Date(), inboundMessageId: String(inboundMessage._id),
        },
      } }, { runValidators: true });
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
  if (automationPaused && !safetyReviewRequired) {
    await completeCoalescedJobs({
      conversationId: conversation._id, primaryJobId: job._id,
      primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds,
    });
    return { decision: "skipped", reason: "ai_ineligible" };
  }

  if (!deterministicAssessment.handled && !automationPaused && !turnPlan.compound) {
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
      const refreshedLead = await Lead.findByIdAndUpdate(lead._id, interruptUpdates, { returnDocument: "after", runValidators: true });
      if (refreshedLead) Object.assign(lead, typeof refreshedLead.toObject === 'function' ? refreshedLead.toObject() : refreshedLead);
      await Conversation.findByIdAndUpdate(conversation._id, { $set: { ...buildSmsStatePatch({ conversation, classification,
        outcome: { intent: directResult.messageCategory }, hasCustomerReply: true }), ...revisionPatch } }, { runValidators: true });
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
  }

  if (!deterministicAssessment.handled && !automationPaused && !turnPlan.compound) {
    const eligibilityResult = await guardServiceRequest({ business, lead, conversation,
      customerMessage: customerTurn.customerMessage, turnId: String(inboundMessage._id) });
    if (eligibilityResult) {
      const delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage, result: eligibilityResult });
      SocketService.emitLeadUpdated(business._id, lead);
      SocketService.emitConversationUpdated(business._id, conversation);
      await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id,
        primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
      return { decision: eligibilityResult.decision, reason: eligibilityResult.serviceEligibility?.reason || eligibilityResult.guardrail?.reason,
        sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
    }
  }

  // Completed manual intake stays in the staff queue. New messages are already
  // durable; attach an action-required alert instead of restarting AI intake.
  if ((conversation?.orchestration?.handoffReason === "intake_complete" && !handoffSource && !turnPlan.compound &&
      !classification.intents?.human && !classification.intents?.callback) ||
      (automationPaused && safetyReviewRequired)) {
    const safety = deterministicAssessment.handled &&
      (["emergency", "hazardous_diy_request"].includes(deterministicAssessment.category) ||
      deterministicAssessment.reason === "safety_clarification_required");
    // This branch bypasses the ordinary AI result persistence. Preserve facts
    // and raise urgency before creating the durable staff task or replying.
    const urgency = preserveHigherUrgency(lead.urgency,
      safety ? (deterministicAssessment.category === "emergency" ? "emergency" : "high") : classification.entities?.urgency);
    assertDistributedLeaseActive();
    const facts = safety ? captureTurnFacts({ customerMessage: customerTurn.customerMessage, classification, business, lead }) : {};
    const followUpLead = await Lead.findByIdAndUpdate(lead._id,
      { $set: { ...facts, urgency } }, { returnDocument: "after", runValidators: true });
    Object.assign(lead, facts, { urgency });
    const intent = safety ? deterministicAssessment.category : "intake_follow_up";
    const followUpConversation = await Conversation.findByIdAndUpdate(conversation._id, {
      $set: {
        "conversationMemory.urgency": urgency,
        "conversationMemory.lastIntent": intent,
        "conversationMemory.lastUpdatedAt": new Date(),
        "orchestration.lastIntent": intent,
        "orchestration.lastOutcome": "queued_for_team",
        "orchestration.lastInboundMessage": inboundMessage._id,
        "orchestration.lastCustomerTurnAt": new Date(),
      },
    }, { returnDocument: "after", runValidators: true });
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
    await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id, primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
    return { decision: "queued_for_team", reason: automationPaused ? "staff_safety_review" : "intake_complete", sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
  }

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
    await completeCoalescedJobs({
      conversationId: conversation._id,
      primaryJobId: job._id,
      primaryMessageId: inboundMessage._id,
      turnMessageIds: customerTurn.turnMessageIds,
    });
    return { decision: "skipped", reason: "ai_ineligible" };
  }

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

  let updatedLead = lead;
  let updatedConversation = conversation;
  const revisionPatch = buildSmsRequestRevisionPatch({ result, lead, conversation });
  const leadUpdates = buildLeadUpdates(lead, result);
  if (Object.keys(leadUpdates).length) {
    updatedLead = await Lead.findByIdAndUpdate(lead._id, leadUpdates, {
      returnDocument: "after",
      runValidators: true,
    });
  }
  // Shared intake may already have saved the facts. Valuation must still finish.
  updatedLead = await finishValuation(valuationTicket, { businessId: business._id, evidence: [...messages.filter(message => message.direction === "inbound").map(message => message.body), customerTurn.customerMessage].join("\n"), proposedService: result.serviceNeeded || updatedLead.serviceNeeded }) || updatedLead;
  SocketService.emitLeadUpdated(business._id, updatedLead);

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
  updatedConversation = await Conversation.findByIdAndUpdate(
    updatedConversation._id,
    { $set: { ...statePatch, ...revisionPatch, ...pendingHandoffPatch,
      ...(handoffRequired && !revisionPatch['conversationMemory.recoveryIntake'] ? { 'conversationMemory.recoveryIntake.preparedHandoffResult': {
        reply: result.reply, intakeCompletionReply: result.reply, intakeReview: result.intakeReview,
        messageCategory: result.messageCategory, serviceNeeded: result.serviceNeeded, urgency: result.urgency,
        address: result.address, preferredAppointmentTime: result.preferredAppointmentTime, summary: result.summary,
        guardrail: result.guardrail,
      } } : {}),
    } },
    { returnDocument: "after", runValidators: true },
  );
  SocketService.emitConversationUpdated(business._id, updatedConversation);

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
    updatedConversation = await Conversation.findByIdAndUpdate(updatedConversation._id,
      { $set: reviewPatch }, { returnDocument: 'after', runValidators: true });
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
    if (handoffRequired) {
      const latestConversation =
        (await Conversation.findById(updatedConversation._id)) ||
        updatedConversation;
      const failedConversation = await Conversation.findByIdAndUpdate(
        updatedConversation._id,
        {
          $set: buildFailedHumanHandoffUpdate({
            inboundMessageId: inboundMessage._id,
            conversation: latestConversation,
            result,
            error,
          }),
          $inc: { "orchestration.silentFailureCount": 1 },
        },
        { returnDocument: "after", runValidators: true },
      );
      SocketService.emitConversationUpdated(business._id, failedConversation);
      await AlertService.createSystemAlert({
        businessId: business._id,
        title: "Human handoff acknowledgement failed",
        message:
          "CallBackIQ could not confirm the customer handoff SMS. The queue will retry; review this conversation immediately.",
        priority: "critical",
        metadata: {
          conversationId: String(updatedConversation._id),
          inboundMessageId: String(inboundMessage._id),
          errorCode: String(error?.code || "SMS_HANDOFF_DELIVERY_FAILED"),
        },
        dedupeKey: `sms_handoff_delivery_failed:${inboundMessage._id}`,
      });
    }
    throw error;
  }

  if (handoffRequired) {
    const deliveryStatus = delivery?.sent
      ? "acknowledged"
      : delivery?.suppressed
        ? "suppressed"
        : "delivery_uncertain";
    const latestConversation =
      (await Conversation.findById(updatedConversation._id)) ||
      updatedConversation;
    updatedConversation = await Conversation.findByIdAndUpdate(
      updatedConversation._id,
      {
        $set: buildFinalizedHumanHandoffUpdate({
          inboundMessageId: inboundMessage._id,
          outboundMessageId: delivery?.message?._id || null,
          conversation: latestConversation,
          result,
          deliveryStatus,
        }),
      },
      { returnDocument: "after", runValidators: true },
    );
    SocketService.emitConversationUpdated(business._id, updatedConversation);
    SocketService.emitDashboardRefresh(business._id, "sms_handoff_pending");
    logOperationalEvent("twilio.sms.handoff_pending", {
      businessId: business._id,
      conversationId: updatedConversation._id,
      inboundMessageId: inboundMessage._id,
      outboundMessageId: delivery?.message?._id || null,
      deliveryStatus,
    });
  }

  await completeCoalescedJobs({
    conversationId: updatedConversation._id,
    primaryJobId: job._id,
    primaryMessageId: inboundMessage._id,
    turnMessageIds: customerTurn.turnMessageIds,
  });

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
