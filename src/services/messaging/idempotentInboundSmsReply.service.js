import Message from "../../models/message.js";
import Conversation from "../../models/conversation.js";
import { sendSms } from "../twilioSmsService.js";
import AlertService from "../alert.service.js";
import SocketService from "../socket.service.js";

const uncertainCodes = new Set([
  "SMS_PROVIDER_OUTCOME_UNCERTAIN",
  "SMS_DELIVERY_RECONCILIATION_REQUIRED",
]);

const createUncertainAlert = async ({
  businessId,
  conversationId,
  inboundMessageId,
  outboundMessageId,
}) =>
  AlertService.createSystemAlert({
    businessId,
    title: "SMS delivery needs review",
    message:
      "A CallBackIQ reply may have reached the customer, but the provider result could not be confirmed. Review the conversation before sending again.",
    priority: "high",
    metadata: {
      conversationId: String(conversationId),
      inboundMessageId: String(inboundMessageId),
      outboundMessageId: String(outboundMessageId),
    },
    dedupeKey: `sms_delivery_uncertain:${outboundMessageId}`,
  });

export const sendIdempotentInboundSmsReply = async ({
  business,
  lead,
  conversation,
  inboundMessage,
  body,
  generatedBy = "guardrail",
  usageCategory = "guardrail_reply",
  actorType = "webhook",
  allowOptedOut = false,
  bypassUsageLimits = false,
  metadata = {},
}) => {
  const reply = String(body || "").trim();
  if (!reply) {
    return { sent: false, skipped: true, reason: "empty_reply" };
  }

  const businessId = business?._id || business?.id;
  const inboundMessageId = inboundMessage?._id || inboundMessage?.id;
  if (!businessId || !inboundMessageId || !conversation?._id) {
    const error = new Error(
      "business, conversation, and inboundMessage are required for an idempotent inbound SMS reply.",
    );
    error.code = "SMS_IDEMPOTENT_REPLY_CONTEXT_REQUIRED";
    throw error;
  }

  let outbound = await Message.findOne({
    business: businessId,
    inReplyToMessage: inboundMessageId,
  });

  if (
    outbound?.providerMessageId ||
    outbound?.status === "suppressed" ||
    outbound?.deliveryUncertain === true
  ) {
    return {
      sent: Boolean(outbound.providerMessageId),
      suppressed: outbound.status === "suppressed",
      deliveryUncertain: outbound.deliveryUncertain === true,
      duplicate: true,
      message: outbound,
    };
  }

  if (outbound?.deliveryAttemptedAt && !outbound.providerMessageId) {
    outbound = await Message.findByIdAndUpdate(
      outbound._id,
      {
        status: "failed",
        deliveryStatus: "failed",
        deliveryUncertain: true,
        deliveryErrorMessage:
          "The process restarted after the provider send began. Automatic resend was blocked to prevent a duplicate customer message.",
      },
      { returnDocument: "after" },
    );
    await createUncertainAlert({
      businessId,
      conversationId: conversation._id,
      inboundMessageId,
      outboundMessageId: outbound._id,
    });
    return {
      sent: false,
      duplicate: true,
      deliveryUncertain: true,
      reason: "delivery_uncertain",
      message: outbound,
    };
  }

  if (!outbound) {
    try {
      outbound = await Message.create({
        business: businessId,
        conversation: conversation._id,
        lead: lead?._id || conversation.lead || null,
        direction: "outbound",
        from: conversation.replyFromPhone || business.phone,
        to: conversation.customerPhone,
        body: reply,
        provider: "twilio",
        providerMessageId: "",
        status: "queued",
        deliveryStatus: "queued",
        isAiGenerated: generatedBy === "ai",
        generatedBy,
        usageCategory,
        actorType,
        inReplyToMessage: inboundMessageId,
        metadata: {
          ...metadata,
          source: metadata.source || "inbound_sms_deterministic_reply",
          idempotencyKey: `sms-inbound-reply:${businessId}:${inboundMessageId}`,
        },
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      outbound = await Message.findOne({
        business: businessId,
        inReplyToMessage: inboundMessageId,
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
        deliveryStatus: "queued",
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
    return {
      sent: Boolean(latest?.providerMessageId),
      suppressed: latest?.status === "suppressed",
      deliveryUncertain: latest?.deliveryUncertain === true,
      duplicate: true,
      message: latest,
    };
  }

  try {
    const sent = await sendSms({
      business,
      businessId,
      from: conversation.replyFromPhone || business.phone,
      to: conversation.customerPhone,
      body: reply,
      actorType,
      source: metadata.source || "inbound_sms_deterministic_reply",
      usageCategory,
      conversationId: conversation._id,
      leadId: lead?._id || conversation.lead || null,
      directResponse: true,
      allowOptedOut,
      bypassUsageLimits,
      metadata: {
        ...metadata,
        inboundMessageId: String(inboundMessageId),
        idempotencyKey: `sms-inbound-reply:${businessId}:${inboundMessageId}`,
      },
    });

    const status =
      sent?.suppressed === true ? "suppressed" : sent?.status || "sent";
    const saved = await Message.findByIdAndUpdate(
      claimed._id,
      {
        providerMessageId: sent?.sid || "",
        body: sent?.body || reply,
        status,
        deliveryStatus: status,
        encoding: sent?.encoding || "",
        segmentCount: sent?.segmentCount || 1,
        deliveryUncertain: false,
        deliveryErrorCode: sent?.providerCode
          ? String(sent.providerCode)
          : "",
        deliveryErrorMessage: sent?.reason || "",
        metadata: {
          ...claimed.metadata,
          ...metadata,
          usage: sent?.usage || null,
          suppressionReason: sent?.suppressed ? sent.reason : null,
        },
      },
      { returnDocument: "after", runValidators: true },
    );

    SocketService.emitMessageCreated(businessId, saved);

    if (sent?.suppressed !== true) {
      const updatedConversation = await Conversation.findByIdAndUpdate(
        conversation._id,
        {
          lastMessage: sent?.body || reply,
          lastMessageAt: new Date(),
        },
        { returnDocument: "after" },
      );
      SocketService.emitConversationUpdated(businessId, updatedConversation);
      SocketService.emitDashboardRefresh(
        businessId,
        "inbound_sms_deterministic_reply_sent",
      );
    }

    return {
      sent: Boolean(sent?.sid) && sent?.suppressed !== true,
      suppressed: sent?.suppressed === true,
      message: saved,
      provider: sent,
    };
  } catch (error) {
    const uncertain =
      error?.deliveryUncertain === true ||
      uncertainCodes.has(String(error?.code || ""));
    await Message.findByIdAndUpdate(claimed._id, {
      status: "failed",
      deliveryStatus: "failed",
      deliveryAttemptedAt: uncertain
        ? claimed.deliveryAttemptedAt || new Date()
        : null,
      deliveryUncertain: uncertain,
      deliveryErrorCode: String(error?.code || "provider_error"),
      deliveryErrorMessage: String(
        error?.message || "SMS provider failure",
      ).slice(0, 1000),
    });

    if (uncertain) {
      await createUncertainAlert({
        businessId,
        conversationId: conversation._id,
        inboundMessageId,
        outboundMessageId: claimed._id,
      });
      return {
        sent: false,
        deliveryUncertain: true,
        reason: "delivery_uncertain",
        message: claimed,
      };
    }

    throw error;
  }
};

export default {
  sendIdempotentInboundSmsReply,
};
