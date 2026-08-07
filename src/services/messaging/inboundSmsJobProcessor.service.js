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

const VALID_URGENCIES = new Set(["low", "medium", "high", "emergency"]);

const getMessagesForReply = async (conversationId) =>
  typeof Db.getMessagesForAI === "function"
    ? Db.getMessagesForAI(Message, conversationId)
    : Db.getMessagesByConversation(Message, conversationId);

const buildLeadUpdates = (lead, result) => {
  const updates = {};
  const serviceNeeded = String(result?.serviceNeeded || "").trim();
  if (serviceNeeded && serviceNeeded !== "Unknown") updates.serviceNeeded = serviceNeeded;

  if (result?.messageCategory === "emergency") updates.urgency = "emergency";
  else if (VALID_URGENCIES.has(result?.urgency)) updates.urgency = result.urgency;

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
  const estimatedValue = Number(result?.estimatedValue);
  if (Number.isFinite(estimatedValue) && estimatedValue > 0) updates.estimatedValue = estimatedValue;
  if (!lead.firstRespondedAt) updates.firstRespondedAt = new Date();
  return updates;
};

const requiresHumanTakeover = (result) => {
  const riskFlags = Array.isArray(result?.riskFlags) ? result.riskFlags : [];
  return (
    ["emergency", "hazardous_diy_request", "human_requested"].includes(
      result?.messageCategory,
    ) ||
    riskFlags.includes("safety_hazard") ||
    riskFlags.includes("hazardous_diy_request")
  );
};

const persistOutboundReply = async ({
  business,
  lead,
  conversation,
  inboundMessage,
  result,
}) => {
  const reply = String(result?.reply || "").trim();
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
        from: business.phone,
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
      from: business.phone,
      to: conversation.customerPhone,
      body: reply,
      actorType: isAiGenerated ? "ai" : "webhook",
      source: "inbound_sms_reply",
      usageCategory,
      conversationId: conversation._id,
      leadId: lead._id,
      directResponse: true,
      metadata: {
        aiGenerated: isAiGenerated,
        generatedBy: isAiGenerated ? "ai" : "guardrail",
        decision: result?.decision,
        messageCategory: result?.messageCategory,
        inboundMessageId: String(inboundMessage._id),
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
    await Message.findByIdAndUpdate(claimed._id, {
      status: "failed",
      deliveryStatus: "failed",
      deliveryAttemptedAt: null,
      deliveryErrorCode: String(error?.code || "provider_error"),
      deliveryErrorMessage: String(error?.message || "SMS provider failure").slice(0, 1000),
    });
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

  const messages = await getMessagesForReply(conversation._id);
  const deterministicAssessment = evaluateDeterministicInboundGuardrails({
    customerMessage: inboundMessage.body,
    recentMessages: messages,
  });
  const aiQualificationEnabled = isBusinessFeatureEnabled(
    business,
    "aiQualificationEnabled",
  );
  const mayProcessAI =
    conversation.aiEnabled !== false &&
    conversation.humanTakeover !== true &&
    conversation.status !== "closed" &&
    conversation.status !== "archived" &&
    (deterministicAssessment.handled || aiQualificationEnabled);

  if (!mayProcessAI) {
    logOperationalEvent("twilio.sms.ai_skipped", {
      businessId: business._id,
      conversationId: conversation._id,
      aiEnabled: conversation.aiEnabled,
      humanTakeover: conversation.humanTakeover,
      conversationStatus: conversation.status,
      aiQualificationEnabled,
      deterministicHandled: deterministicAssessment.handled,
    });
    return { decision: "skipped", reason: "ai_ineligible" };
  }

  const orchestration = await ConversationOrchestratorService.process({
    business,
    lead,
    conversation,
    messages,
    inboundMessage,
  });
  const result = orchestration.result;

  let updatedLead = lead;
  let updatedConversation = conversation;
  const leadUpdates = buildLeadUpdates(lead, result);
  if (Object.keys(leadUpdates).length) {
    updatedLead = await Lead.findByIdAndUpdate(lead._id, leadUpdates, {
      returnDocument: "after",
      runValidators: true,
    });
    SocketService.emitLeadUpdated(business._id, updatedLead);
  }

  if (requiresHumanTakeover(result)) {
    updatedConversation = await Conversation.findByIdAndUpdate(
      conversation._id,
      {
        aiEnabled: false,
        humanTakeover: true,
        humanTakeoverAt: new Date(),
        humanTakeoverBy: null,
      },
      { returnDocument: "after", runValidators: true },
    );
    SocketService.emitConversationUpdated(business._id, updatedConversation);
  }

  if (result?.shouldAlertOwner === true) {
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

  const delivery = await persistOutboundReply({
    business,
    lead: updatedLead,
    conversation: updatedConversation,
    inboundMessage,
    result,
  });

  return {
    decision: result?.decision || "reply",
    messageCategory: result?.messageCategory || "unknown",
    outboundMessageId: delivery?.message?._id || null,
    sent: delivery?.sent === true,
    suppressed: delivery?.suppressed === true,
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
