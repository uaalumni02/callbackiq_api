import Db from "../../db/db.js";
import Business from "../../models/business.js";
import Conversation from "../../models/conversation.js";
import Message from "../../models/message.js";
import { sendSms } from "../twilioSmsService.js";
import SocketService from "../socket.service.js";
import { evaluateManualSmsPolicy } from "./manualSmsPolicy.service.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";

const getBusinessForOwner = async (ownerId) =>
  typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);

export const handleConversationManualMessage = async (req, res) => {
  try {
    const ownerId = req.user?.userId;
    if (!ownerId) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const business = await getBusinessForOwner(ownerId);
    if (!business) {
      return res.status(400).json({ success: false, message: "Business not found" });
    }

    const conversationId = req.body?.conversation;
    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: business._id,
      status: { $ne: "archived" },
    });
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }

    const policy = await evaluateManualSmsPolicy({
      business,
      to: conversation.customerPhone,
      body: req.body?.body,
      conversationId: conversation._id,
    });
    if (!policy.allowed) {
      return res.status(policy.statusCode || 400).json({
        success: false,
        message: policy.message || "Manual SMS is not permitted.",
        data: { reason: policy.reason },
      });
    }

    const mutedConversation = await Conversation.findByIdAndUpdate(
      conversation._id,
      {
        aiEnabled: false,
        humanTakeover: true,
        humanTakeoverAt: new Date(),
        humanTakeoverBy: ownerId,
      },
      { returnDocument: "after", runValidators: true },
    );
    SocketService.emitConversationUpdated(business._id, mutedConversation);

    const sent = await sendSms({
      business,
      businessId: business._id,
      from: business.phone,
      to: policy.normalizedTo,
      body: policy.body,
      actorId: ownerId,
      actorType: "user",
      source: "conversation_manual_reply",
      usageCategory: "manual_sms",
      conversationId: conversation._id,
      leadId: conversation.lead || null,
      directResponse: policy.directResponse,
      metadata: { route: "/api/messages", humanTakeover: true },
    });

    if (sent?.suppressed) {
      return res.status(sent.policyBlocked ? 429 : 409).json({
        success: false,
        message: sent.policyBlocked
          ? sent.reason === "outside_send_window"
            ? "This message is outside the configured customer send window."
            : "The communication allowance has been reached."
          : "SMS was not sent because the customer opted out.",
        data: { status: sent.status, reason: sent.reason },
      });
    }

    const message = await Message.create({
      business: business._id,
      conversation: conversation._id,
      lead: conversation.lead || null,
      direction: "outbound",
      from: business.phone,
      to: policy.normalizedTo,
      body: sent?.body || policy.body,
      provider: "twilio",
      providerMessageId: sent?.sid || "",
      status: sent?.status || "sent",
      deliveryStatus: sent?.status || "sent",
      encoding: sent?.encoding || "",
      segmentCount: sent?.segmentCount || 1,
      isAiGenerated: false,
      generatedBy: "user",
      usageCategory: "manual_sms",
      actorType: "user",
      actorId: ownerId,
      metadata: { source: "conversation_manual_reply", humanTakeover: true },
    });
    const updatedConversation = await Conversation.findByIdAndUpdate(
      conversation._id,
      { lastMessage: sent?.body || policy.body, lastMessageAt: new Date() },
      { returnDocument: "after" },
    );
    SocketService.emitMessageCreated(business._id, message);
    SocketService.emitConversationUpdated(business._id, updatedConversation);
    SocketService.emitDashboardRefresh(business._id, "manual_message_sent");

    return res.status(201).json({
      success: true,
      message: "Message sent successfully. AI is paused for this conversation.",
      data: message,
    });
  } catch (error) {
    logOperationalError("message.manual_send.failed", error, {
      ownerId: req.user?.userId,
      conversationId: req.body?.conversation,
    });
    return res.status(500).json({ success: false, message: "Unable to send message." });
  }
};

export default { handleConversationManualMessage };
