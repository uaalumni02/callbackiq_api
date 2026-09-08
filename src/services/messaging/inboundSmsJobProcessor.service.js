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
  buildHumanHandoffStatusResult,
  buildPendingHumanHandoffUpdate,
  ensureHumanHandoffResult,
  ensureUrgentOperationalResult,
  isHumanHandoffSource,
  isHumanHandoffStatusQuestion,
  isUrgentOperationalResult,
  requiresHumanHandoff,
  shouldSendHumanHandoffStatusAcknowledgement,
} from "./smsHandoff.service.js";
import { sanitizeUnverifiedStaffCommitments } from "../customerCommitmentSafety.service.js";

const VALID_URGENCIES = new Set(["low", "medium", "high", "emergency"]);
const SMS_URGENCY_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  emergency: 3,
});
const preserveHigherUrgency = (current, candidate) => {
  const currentValue = VALID_URGENCIES.has(String(current || ""))
    ? String(current)
    : "medium";
  const candidateValue = VALID_URGENCIES.has(String(candidate || ""))
    ? String(candidate)
    : "";
  if (!candidateValue) return currentValue;
  return SMS_URGENCY_RANK[candidateValue] > SMS_URGENCY_RANK[currentValue]
    ? candidateValue
    : currentValue;
};

const getMessagesForReply = async (conversationId) =>
  typeof Db.getMessagesForAI === "function"
    ? Db.getMessagesForAI(Message, conversationId)
    : Db.getMessagesByConversation(Message, conversationId);

const buildLeadUpdates = (lead, result) => {
  const updates = { aiExtraction: { source: "customer_sms", observedAt: new Date(), verified: false } };
  const serviceNeeded = String(result?.serviceNeeded || "").trim();
  if (serviceNeeded && serviceNeeded !== "Unknown") updates.serviceNeeded = serviceNeeded;

  if (result?.messageCategory === "emergency") {
    updates.urgency = "emergency";
  } else if (VALID_URGENCIES.has(result?.urgency)) {
    const preservedUrgency = preserveHigherUrgency(
      lead?.urgency,
      result.urgency,
    );
    if (preservedUrgency !== lead?.urgency) {
      updates.urgency = preservedUrgency;
    }
  }

  for (const [field, value] of [
    ["address", result?.address],
    ["preferredAppointmentTime", result?.preferredAppointmentTime],
    ["summary", result?.summary],
  ]) {
    const normalized = String(value || "").trim();
    if (normalized) updates[field] = normalized;
  }

  const score = Number(result?.leadQualityScore ?? result?.score);
  if (Number.isFinite(score)) updates.leadQualityScore = Math.min(100, Math.max(0, score));
  if (!lead.firstRespondedAt) updates.firstRespondedAt = new Date();
  return updates;
};

const persistOutboundReply = async ({
  business,
  lead,
  conversation,
  inboundMessage,
  result,
}) => {
  const reply = sanitizeUnverifiedStaffCommitments(result?.reply, {
    channel: "sms",
  });
  if (!reply || result?.decision === "no_reply") return { sent: false, reason: "no_reply" };

  const isAiGenerated = result?.guardrail?.skipAI !== true;
  const usageCategory =
    result?.messageCategory === "emergency"
      ? "safety"
      : isAiGenerated
        ? "ai_reply"
        : "guardrail_reply";

  let outbound = await Message.findOne({
    business: business._id,
    inReplyToMessage: inboundMessage._id,
  });

  if (outbound?.providerMessageId) {
    return { sent: true, duplicate: true, message: outbound };
  }

  if (outbound?.deliveryAttemptedAt && !outbound.providerMessageId) {
    outbound = await Message.findByIdAndUpdate(
      outbound._id,
      {
        status: "failed",
        deliveryUncertain: true,
        deliveryErrorMessage:
          "The worker restarted after the provider send began. Automatic resend was blocked to prevent a duplicate customer message.",
      },
      { returnDocument: "after" },
    );
    await AlertService.createSystemAlert({
      businessId: business._id,
      title: "SMS delivery needs review",
      message:
        "An AI reply may have reached the customer, but CallBackIQ could not confirm the provider result. Review the conversation before sending again.",
      priority: "high",
      metadata: {
        conversationId: String(conversation._id),
        inboundMessageId: String(inboundMessage._id),
        outboundMessageId: String(outbound._id),
      },
      dedupeKey: `sms_delivery_uncertain:${outbound._id}`,
    });
    return { sent: false, reason: "delivery_uncertain", message: outbound };
  }

  if (!outbound) {
    try {
      outbound = await Message.create({
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        direction: "outbound",
        from: conversation.replyFromPhone || business.phone,
        to: conversation.customerPhone,
        body: reply,
        provider: "twilio",
        providerMessageId: "",
        status: "queued",
        isAiGenerated,
        generatedBy: isAiGenerated ? "ai" : "guardrail",
        usageCategory,
        actorType: isAiGenerated ? "ai" : "webhook",
        inReplyToMessage: inboundMessage._id,
        metadata: {
          source: "inbound_sms_reply",
          decision: result?.decision || "reply",
          messageCategory: result?.messageCategory || "unknown",
          handoffRequired: result?.handoff?.required === true,
          handoffReason: result?.handoff?.reason || "",
          handoffStatusAcknowledgement:
            result?.handoff?.statusAcknowledgement === true,
          idempotencyKey: `sms-inbound-reply:${business._id}:${inboundMessage._id}`,
        },
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      outbound = await Message.findOne({
        business: business._id,
        inReplyToMessage: inboundMessage._id,
      });
    }
  }

  const claimed = await Message.findOneAndUpdate(
    {
      _id: outbound._id,
      providerMessageId: "",
      deliveryAttemptedAt: null,
      status: { $in: ["queued", "failed"] },
    },
    {
      $set: {
        status: "queued",
        deliveryAttemptedAt: new Date(),
        deliveryUncertain: false,
        deliveryErrorCode: "",
        deliveryErrorMessage: "",
      },
    },
    { returnDocument: "after" },
  );

  if (!claimed) {
    const latest = await Message.findById(outbound._id);
    return { sent: Boolean(latest?.providerMessageId), duplicate: true, message: latest };
  }

  try {
    const sent = await sendSms({
      business,
      businessId: business._id,
      from: conversation.replyFromPhone || business.phone,
      to: conversation.customerPhone,
      body: reply,
      actorType: isAiGenerated ? "ai" : "webhook",
      source: "inbound_sms_reply",
      usageCategory,
      conversationId: conversation._id,
      leadId: lead._id,
      directResponse: true,
      bypassUsageLimits:
        result?.handoff?.required === true ||
        result?.handoff?.statusAcknowledgement === true,
      metadata: {
        aiGenerated: isAiGenerated,
        generatedBy: isAiGenerated ? "ai" : "guardrail",
        decision: result?.decision,
        messageCategory: result?.messageCategory,
        inboundMessageId: String(inboundMessage._id),
        handoffRequired: result?.handoff?.required === true,
        handoffReason: result?.handoff?.reason || "",
        handoffStatusAcknowledgement:
          result?.handoff?.statusAcknowledgement === true,
        idempotencyKey: `sms-inbound-reply:${business._id}:${inboundMessage._id}`,
      },
    });

    const status = sent?.suppressed === true ? "suppressed" : sent?.status || "sent";
    outbound = await Message.findByIdAndUpdate(
      claimed._id,
      {
        providerMessageId: sent?.sid || "",
        body: sent?.body || reply,
        status,
        deliveryStatus: status,
        encoding: sent?.encoding || "",
        segmentCount: sent?.segmentCount || 1,
        deliveryErrorCode: sent?.providerCode ? String(sent.providerCode) : "",
        deliveryErrorMessage: sent?.reason || "",
        metadata: {
          ...claimed.metadata,
          usage: sent?.usage || null,
          suppressionReason: sent?.suppressed ? sent.reason : null,
        },
      },
      { returnDocument: "after", runValidators: true },
    );

    SocketService.emitMessageCreated(business._id, outbound);
    if (sent?.suppressed === true) {
      logOperationalEvent("twilio.sms.reply_suppressed", {
        businessId: business._id,
        reason: sent.reason || "customer_opted_out",
      });
      return { sent: false, suppressed: true, message: outbound };
    }

    const updatedConversation = await Conversation.findByIdAndUpdate(
      conversation._id,
      { lastMessage: sent?.body || reply, lastMessageAt: new Date() },
      { returnDocument: "after" },
    );
    SocketService.emitConversationUpdated(business._id, updatedConversation);
    SocketService.emitDashboardRefresh(business._id, "inbound_sms_reply_sent");
    logOperationalEvent("twilio.sms.reply_sent", {
      businessId: business._id,
      providerMessageId: sent?.sid || "",
      segmentCount: sent?.segmentCount || 1,
    });
    return { sent: true, message: outbound };
  } catch (error) {
    const uncertain = [
      "SMS_PROVIDER_OUTCOME_UNCERTAIN",
      "SMS_DELIVERY_RECONCILIATION_REQUIRED",
    ].includes(String(error?.code || ""));
    await Message.findByIdAndUpdate(claimed._id, {
      status: "failed",
      deliveryStatus: "failed",
      deliveryAttemptedAt: uncertain ? claimed.deliveryAttemptedAt || new Date() : null,
      deliveryUncertain: uncertain,
      deliveryErrorCode: String(error?.code || "provider_error"),
      deliveryErrorMessage: String(error?.message || "SMS provider failure").slice(0, 1000),
    });
    if (uncertain) {
      await AlertService.createSystemAlert({
        businessId: business._id,
        title: "SMS provider outcome requires reconciliation",
        message: "CallBackIQ blocked an automatic resend because Twilio may have accepted the reply. Review provider reconciliation before sending again.",
        priority: "high",
        metadata: {
          conversationId: String(conversation._id),
          inboundMessageId: String(inboundMessage._id),
          outboundMessageId: String(claimed._id),
        },
        dedupeKey: `sms_delivery_uncertain:${claimed._id}`,
      });
      return { sent: false, reason: "delivery_uncertain", message: claimed };
    }
    throw error;
  }
};

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
  const messages = customerTurn.historyMessages;
  const effectiveInboundMessage = customerTurn.primaryInboundMessage;
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
   * Once a person owns the conversation, CallBackIQ does not restart the AI.
   * It may send one deterministic, throttled status acknowledgement when the
   * customer asks whether the callback request was received.
   */
  const classification = classifySmsIntent({
    customerMessage: customerTurn.customerMessage,
    business,
    conversation,
  });
  const deterministicAssessment = evaluateDeterministicInboundGuardrails({
    customerMessage: customerTurn.customerMessage,
    recentMessages: messages,
    activityWindowStartAt:
      conversation?.orchestration?.recoveryJourneyStartedAt || null,
  });
  const handoffLifecycleActive =
    conversation.humanTakeover === true ||
    conversation?.orchestration?.phase === "handoff_pending" ||
    Boolean(conversation?.orchestration?.handoffStatus);
  const handoffStatusQuestion =
    handoffLifecycleActive &&
    isHumanHandoffStatusQuestion(customerTurn.customerMessage);

  if (handoffStatusQuestion && !deterministicAssessment.handled) {
    if (!shouldSendHumanHandoffStatusAcknowledgement({ conversation })) {
      await completeCoalescedJobs({
        conversationId: conversation._id,
        primaryJobId: job._id,
        primaryMessageId: inboundMessage._id,
        turnMessageIds: customerTurn.turnMessageIds,
      });
      return {
        decision: "skipped",
        reason: "human_handoff_status_throttled",
      };
    }

    const statusResult = buildHumanHandoffStatusResult({ business, conversation });
    const delivery = await persistOutboundReply({
      business,
      lead,
      conversation,
      inboundMessage,
      result: statusResult,
    });

    if (
      delivery?.sent === true ||
      delivery?.suppressed === true ||
      delivery?.reason === "delivery_uncertain"
    ) {
      const statusUpdatedConversation = await Conversation.findByIdAndUpdate(
        conversation._id,
        {
          $set: {
            "orchestration.handoffStatusReplyAt": new Date(),
            "orchestration.lastOutboundMessage": delivery?.message?._id || null,
          },
        },
        { returnDocument: "after", runValidators: true },
      );
      SocketService.emitConversationUpdated(
        business._id,
        statusUpdatedConversation,
      );
    }

    await completeCoalescedJobs({
      conversationId: conversation._id,
      primaryJobId: job._id,
      primaryMessageId: inboundMessage._id,
      turnMessageIds: customerTurn.turnMessageIds,
    });

    return {
      decision: statusResult.decision,
      messageCategory: statusResult.messageCategory,
      outboundMessageId: delivery?.message?._id || null,
      sent: delivery?.sent === true,
      suppressed: delivery?.suppressed === true,
    };
  }

  // Completed manual intake stays in the staff queue. New messages are already
  // durable; attach an action-required alert instead of restarting AI intake.
  if (conversation?.orchestration?.handoffReason === "intake_complete" && !handoffSource) {
    const safety = deterministicAssessment.handled &&
      ["emergency", "hazardous_diy_request"].includes(deterministicAssessment.category);
    await AlertService.createHumanHandoffAlert({
      businessId: business._id, leadId: lead._id, conversationId: conversation._id,
      messageId: inboundMessage._id, providerMessageId: inboundMessage.providerMessageId,
      customerName: lead.customerName, customerPhone: conversation.customerPhone,
      customerMessage: customerTurn.customerMessage, lead,
      result: {
        messageCategory: safety ? "emergency" : "service_request",
        urgency: safety ? "emergency" : classification.entities.urgency || lead.urgency,
        summary: "Additional customer message after completed intake; review the full conversation.",
        handoff: { reason: "intake_follow_up", callbackRequested: false },
        riskFlags: safety ? ["safety_hazard"] : [],
      },
    });
    let delivery = { sent: false };
    if (safety && conversation.humanTakeover !== true && !["closed", "archived"].includes(conversation.status)) {
      delivery = await persistOutboundReply({ business, lead, conversation, inboundMessage,
        result: { decision: "send_fixed_response", actionType: "send_fixed_response", messageCategory: "emergency", reply: deterministicAssessment.reply, guardrail: { skipAI: true } },
      });
    }
    await completeCoalescedJobs({ conversationId: conversation._id, primaryJobId: job._id, primaryMessageId: inboundMessage._id, turnMessageIds: customerTurn.turnMessageIds });
    return { decision: "queued_for_team", reason: "intake_complete", sent: delivery.sent === true, outboundMessageId: delivery.message?._id || null };
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
    ? { result: buildCompletedIntakeResult({ business, result: { messageCategory: "service_request", serviceNeeded: lead.serviceNeeded, urgency: lead.urgency, address: lead.address, preferredAppointmentTime: lead.preferredAppointmentTime, summary: lead.summary } }), outcome: { intent: "service_request", outcome: "reply_ready" } }
    : await ConversationOrchestratorService.process({
        business, lead, conversation, messages, inboundMessage: effectiveInboundMessage,
      });
  let result = orchestration.result || {};
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
      customerMessage: customerTurn.customerMessage,
    });
  }

  let updatedLead = lead;
  let updatedConversation = conversation;
  const leadUpdates = buildLeadUpdates(lead, result);
  if (Object.keys(leadUpdates).length) {
    updatedLead = await Lead.findByIdAndUpdate(lead._id, leadUpdates, {
      returnDocument: "after",
      runValidators: true,
    });
    updatedLead = await finishValuation(valuationTicket, { businessId: business._id, evidence: [...messages.filter(message => message.direction === "inbound").map(message => message.body), customerTurn.customerMessage].join("\n"), proposedService: result.serviceNeeded }) || updatedLead;
    SocketService.emitLeadUpdated(business._id, updatedLead);
  }

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

  updatedConversation = await Conversation.findByIdAndUpdate(
    updatedConversation._id,
    { $set: { ...statePatch, ...pendingHandoffPatch } },
    { returnDocument: "after", runValidators: true },
  );
  SocketService.emitConversationUpdated(business._id, updatedConversation);

  if (handoffRequired) {
    await AlertService.createHumanHandoffAlert({
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
