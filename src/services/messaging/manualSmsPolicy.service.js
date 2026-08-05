import mongoose from "mongoose";

import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import Message from "../../models/message.js";
import { normalizeSmsPhone, validateManualSmsBody } from "./smsCompliance.service.js";

const RECENT_RESPONSE_MS = Math.max(
  5 * 60_000,
  Number(process.env.MANUAL_SMS_DIRECT_RESPONSE_WINDOW_MS) || 24 * 60 * 60 * 1000,
);

export const evaluateManualSmsPolicy = async ({
  business,
  to = "",
  body,
  conversationId,
  now = new Date(),
}) => {
  const bodyPolicy = validateManualSmsBody(body);
  if (!bodyPolicy.allowed) return { ...bodyPolicy, statusCode: 400 };
  if (!mongoose.isValidObjectId(conversationId)) {
    return {
      allowed: false,
      reason: "conversation_required",
      message: "Open a valid customer conversation before sending a manual SMS.",
      statusCode: 400,
    };
  }
  const conversation = await Conversation.findOne({
    _id: conversationId,
    business: business._id,
  });
  if (!conversation) {
    return {
      allowed: false,
      reason: "conversation_not_found",
      message: "The selected conversation does not belong to this business.",
      statusCode: 404,
    };
  }
  if (conversation.status === "archived") {
    return {
      allowed: false,
      reason: "conversation_archived",
      message: "Restore the archived conversation before sending a manual SMS.",
      statusCode: 409,
    };
  }
  const lead = conversation.lead
    ? await Lead.findOne({ _id: conversation.lead, business: business._id })
    : null;
  const conversationPhone = normalizeSmsPhone(
    conversation.customerPhone || lead?.phone,
  );
  const requestedPhone = normalizeSmsPhone(to || conversationPhone);
  if (!conversationPhone || !requestedPhone) {
    return {
      allowed: false,
      reason: "invalid_destination",
      message: "The customer conversation does not contain a valid SMS destination.",
      statusCode: 400,
    };
  }
  if (requestedPhone !== conversationPhone) {
    return {
      allowed: false,
      reason: "conversation_destination_mismatch",
      message: "The manual SMS destination does not match the selected conversation.",
      statusCode: 409,
    };
  }
  const recentInbound = await Message.exists({
    business: business._id,
    conversation: conversation._id,
    direction: "inbound",
    createdAt: { $gte: new Date(now.getTime() - RECENT_RESPONSE_MS) },
  });
  return {
    allowed: true,
    body: bodyPolicy.body,
    segment: bodyPolicy.segment,
    normalizedTo: requestedPhone,
    conversation,
    lead,
    directResponse: Boolean(recentInbound),
  };
};

export default { evaluateManualSmsPolicy };
