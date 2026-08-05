import { handleInboundSmsWebhook, handleManualSmsRequest, handleSmsRecoveryVoiceWebhook, handleTwilioStatusWebhook } from "../services/twilioSmsWebhook.service.js";
import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import CallLog from "../models/callLog.js";

import { generateAIReplyResult } from "../services/aiReplyService.js";
import { sendSms } from "../services/twilioSmsService.js";
import { buildSmsRecoveryVoicePrompt } from "../voice/smsRecoveryVoicePrompt.service.js";
import AlertService from "../services/alert.service.js";
import SocketService from "../services/socket.service.js";
import {
  logOperationalEvent,
  logOperationalError,
} from "../helpers/logging/safeLogger.js";

import {
  evaluateDeterministicInboundGuardrails,
} from "../helpers/ai/aiGuardrails.js";
import {
  isBusinessFeatureEnabled,
} from "../helpers/businessFeatures.js";
import {
  buildTwilioEventIdentity,
  getTwilioStatusEventType,
} from "../helpers/twilioEventKey.js";
import {
  processInboundSmsCommand,
} from "../services/messaging/contactPreference.service.js";
import {
  normalizePhoneToE164,
  phoneLookupVariants,
} from "../voice/voicePhone.service.js";
import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
  failTwilioWebhookEvent,
} from "../services/webhooks/twilioWebhookEvent.service.js";

const VALID_URGENCIES = new Set(["low", "medium", "high", "emergency"]);

const getBusinessForWebhook = async (phone) => {
  const direct =
    typeof Db.getBusinessByPhoneForWebhook === "function"
      ? await Db.getBusinessByPhoneForWebhook(Business, phone)
      : await Db.getBusinessByPhone(Business, phone);

  if (direct) return direct;

  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return null;

  return Business.findOne({
    isActive: true,
    $or: [
      { phoneLookup: normalized },
      { phone: { $in: phoneLookupVariants(normalized) } },
    ],
  });
};

const getBusinessFromWebhookPhones = async (phones = []) => {
  const uniquePhones = [
    ...new Set(
      phones
        .map((phone) => String(phone || "").trim())
        .filter(Boolean),
    ),
  ];

  for (const phone of uniquePhones) {
    const business = await getBusinessForWebhook(phone);

    if (business) {
      return business;
    }
  }

  return null;
};

const getMessagesForReply = async (conversationId) => {
  return typeof Db.getMessagesForAI === "function"
    ? Db.getMessagesForAI(Message, conversationId)
    : Db.getMessagesByConversation(Message, conversationId);
};

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const emptyTwiml = () => xml("<Response></Response>");

const normalizeTemplate = (template, business) => {
  const fallback = `Hi, this is ${business.businessName}. Sorry we missed your call. What service do you need help with today?`;

  const text = template || fallback;

  return text.replaceAll("{{businessName}}", business.businessName);
};

const sendXmlResponse = (
  res,
  {
    statusCode = 200,
    contentType = "text/xml",
    responseBody = emptyTwiml(),
  } = {},
) => {
  res.type(contentType);
  return res.status(statusCode).send(responseBody);
};

const sendCachedWebhookResponse = (res, event, fallbackBody = emptyTwiml()) => {
  return sendXmlResponse(res, {
    statusCode: event?.responseStatusCode || 200,
    contentType: event?.responseContentType || "text/xml",
    responseBody: event?.responseBody || fallbackBody,
  });
};

const saveOutboundMessage = async ({
  businessId,
  conversation,
  lead,
  from,
  to,
  body,
  sent,
  isAiGenerated = false,
  generatedBy = "system",
  usageCategory = "sms",
  actorType = "system",
  actorId = null,
  metadata = {},
}) => {
  if (!sent || sent.suppressed === true) {
    return null;
  }

  const outboundMessage = await Db.saveMessage(Message, {
    business: businessId,
    conversation: conversation._id,
    lead: lead?._id || null,
    direction: "outbound",
    from,
    to,
    body,
    provider: "twilio",
    providerMessageId: sent.sid || "",
    status: "sent",
    isAiGenerated,
    generatedBy,
    usageCategory,
    actorType,
    actorId,
    metadata,
  });
  SocketService.emitMessageCreated(businessId, outboundMessage);

  return outboundMessage;
};

const updateConversationLastMessage = async ({
  businessId,
  conversation,
  lastMessage,
}) => {
  const updatedConversation = await Db.updateConversation(
    Conversation,
    conversation._id,
    {
      lastMessage,
      lastMessageAt: new Date(),
    },
  );

  SocketService.emitConversationUpdated(businessId, updatedConversation);

  return updatedConversation;
};

const buildLeadUpdatesFromAIResult = (lead, result) => {
  const updates = {};

  const serviceNeeded = String(result?.serviceNeeded || "").trim();

  if (serviceNeeded && serviceNeeded !== "Unknown") {
    updates.serviceNeeded = serviceNeeded;
  }

  if (result?.messageCategory === "emergency") {
    updates.urgency = "emergency";
  } else if (VALID_URGENCIES.has(result?.urgency)) {
    updates.urgency = result.urgency;
  }

  const address = String(result?.address || "").trim();

  if (address) {
    updates.address = address;
  }

  const preferredAppointmentTime = String(
    result?.preferredAppointmentTime || "",
  ).trim();

  if (preferredAppointmentTime) {
    updates.preferredAppointmentTime = preferredAppointmentTime;
  }

  const leadQualityScore = Number(result?.leadQualityScore);

  if (Number.isFinite(leadQualityScore) && leadQualityScore > 0) {
    updates.leadQualityScore = Math.min(
      100,
      Math.max(Number(lead?.leadQualityScore) || 0, leadQualityScore),
    );
  }

  const estimatedValue = Number(result?.estimatedValue);

  if (Number.isFinite(estimatedValue) && estimatedValue > 0) {
    updates.estimatedValue = estimatedValue;
  }

  const summary = String(result?.summary || "").trim();

  if (summary) {
    updates.summary = summary;
  }

  return updates;
};

const resultRequiresHumanTakeover = (result) => {
  const riskFlags = Array.isArray(result?.riskFlags)
    ? result.riskFlags
    : [];

  return (
    ["emergency", "hazardous_diy_request", "human_requested"].includes(
      result?.messageCategory,
    ) ||
    riskFlags.includes("safety_hazard") ||
    riskFlags.includes("hazardous_diy_request")
  );
};

const applyAIResult = async ({
  businessId,
  lead,
  conversation,
  inboundMessage,
  providerMessageId,
  customerPhone,
  result,
}) => {
  let updatedLead = lead;
  let updatedConversation = conversation;

  const leadUpdates = buildLeadUpdatesFromAIResult(lead, result);

  if (Object.keys(leadUpdates).length > 0) {
    updatedLead = await Db.updateLead(Lead, lead._id, leadUpdates);
    SocketService.emitLeadUpdated(businessId, updatedLead);
  }

  if (resultRequiresHumanTakeover(result)) {
    updatedConversation = await Db.updateConversation(
      Conversation,
      conversation._id,
      {
        aiEnabled: false,
        humanTakeover: true,
      },
    );

    SocketService.emitConversationUpdated(
      businessId,
      updatedConversation,
    );
  }

  if (result?.shouldAlertOwner === true) {
    await AlertService.createAIReviewAlert({
      businessId,
      leadId: updatedLead._id,
      conversationId: updatedConversation._id,
      messageId: inboundMessage._id,
      providerMessageId,
      customerName: updatedLead.customerName,
      customerPhone,
      result,
    });
  }

  return {
    lead: updatedLead,
    conversation: updatedConversation,
  };
};

class TwilioController {
  static async voiceWebhook(req, res) {
    return handleSmsRecoveryVoiceWebhook(req, res);
  }

  static async statusWebhook(req, res) {
    return handleTwilioStatusWebhook(req, res);
  }

  static async handleInboundSms(req, res) {
    return handleInboundSmsWebhook(req, res);
  }

  static async sendManualSms(req, res) {
    return handleManualSmsRequest(req, res);
  }
}

export default TwilioController;
