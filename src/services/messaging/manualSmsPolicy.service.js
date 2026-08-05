import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import Message from "../../models/message.js";
import { phoneLookupVariants } from "../../voice/voicePhone.service.js";
import {
  normalizeSmsPhone,
  validateManualSmsBody,
} from "./smsCompliance.service.js";

const DIRECT_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const evaluateManualSmsPolicy = async ({
  business,
  to,
  body,
  conversationId = null,
  now = new Date(),
}) => {
  if (!business?._id) {
    return { allowed: false, statusCode: 403, reason: "business_required" };
  }

  const normalizedTo = normalizeSmsPhone(to);
  if (!normalizedTo) {
    return {
      allowed: false,
      statusCode: 400,
      reason: "invalid_destination",
      message: "The destination must be a valid U.S. E.164 mobile number.",
    };
  }

  const content = validateManualSmsBody(body);
  if (!content.allowed) {
    return { ...content, statusCode: 400 };
  }

  const phoneVariants = phoneLookupVariants(normalizedTo);
  let conversation = null;
  if (conversationId) {
    conversation = await Conversation.findOne({
      _id: conversationId,
      business: business._id,
      status: { $ne: "archived" },
    });

    if (conversation) {
      const conversationPhone = normalizeSmsPhone(
        conversation.customerPhoneLookup || conversation.customerPhone,
      );
      if (!conversationPhone || conversationPhone !== normalizedTo) {
        return {
          allowed: false,
          statusCode: 403,
          reason: "conversation_destination_mismatch",
          message:
            "The destination does not match the customer phone on this conversation.",
        };
      }
    }
  } else {
    conversation = await Conversation.findOne({
      business: business._id,
      status: { $ne: "archived" },
      $or: [
        { customerPhoneLookup: normalizedTo },
        { customerPhone: { $in: phoneVariants } },
      ],
    }).sort({ lastMessageAt: -1 });
  }

  let lead = conversation?.lead
    ? await Lead.findOne({ _id: conversation.lead, business: business._id })
    : await Lead.findOne({
        business: business._id,
        $or: [
          { phoneLookup: normalizedTo },
          { phone: { $in: phoneVariants } },
        ],
      }).sort({ updatedAt: -1 });

  if (!conversation && !lead) {
    return {
      allowed: false,
      statusCode: 403,
      reason: "destination_not_customer",
      message:
        "Manual SMS is limited to phone numbers already tied to this business's lead or conversation records.",
    };
  }

  if (!conversation && lead) {
    conversation = await Conversation.findOne({
      business: business._id,
      lead: lead._id,
      status: { $ne: "archived" },
    }).sort({ lastMessageAt: -1 });
  }

  const latestInbound = conversation
    ? await Message.findOne({
        business: business._id,
        conversation: conversation._id,
        direction: "inbound",
      })
        .sort({ createdAt: -1 })
        .select("createdAt")
        .lean()
    : null;
  const directResponse = Boolean(
    latestInbound?.createdAt &&
      now.getTime() - new Date(latestInbound.createdAt).getTime() <=
        DIRECT_RESPONSE_WINDOW_MS,
  );

  return {
    allowed: true,
    normalizedTo,
    body: content.body,
    segment: content.segment,
    conversation,
    lead,
    directResponse,
  };
};

export default { evaluateManualSmsPolicy };
