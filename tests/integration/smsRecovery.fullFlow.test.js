import { handleInboundSmsWebhook } from "../../src/services/twilioSmsWebhook.service.js";
import { processInboundSmsJob } from "../../src/services/messaging/inboundSmsJobProcessor.service.js";
import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import Db from "../../src/db/db.js";
import { generateAIReplyResult } from "../../src/services/aiReplyService.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import { resolveBusinessByTwilioNumber } from "../../src/services/twilioBusinessResolver.service.js";
import { getOrCreateSmsLeadAndConversation } from "../../src/services/messaging/smsConversation.service.js";
import { enqueueInboundSmsJob } from "../../src/services/messaging/smsProcessingQueue.service.js";
import {
  classifyInboundSmsCommand,
  processInboundSmsCommand,
} from "../../src/services/messaging/contactPreference.service.js";
import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
} from "../../src/services/webhooks/twilioWebhookEvent.service.js";
import { evaluateDeterministicInboundGuardrails } from "../../src/helpers/ai/aiGuardrails.js";
import { isBusinessFeatureEnabled } from "../../src/helpers/businessFeatures.js";
import AlertService from "../../src/services/alert.service.js";
import SocketService from "../../src/services/socket.service.js";
import { logOperationalEvent } from "../../src/helpers/logging/safeLogger.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findById: jest.fn(), findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { findById: jest.fn(), findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/db/db.js", () => ({
  __esModule: true,
  default: { getMessagesForAI: jest.fn(), getMessagesByConversation: jest.fn() },
}));
jest.mock("../../src/services/aiReplyService.js", () => ({
  __esModule: true,
  generateAIReplyResult: jest.fn(),
}));
jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  sendSms: jest.fn(),
}));
jest.mock("../../src/services/twilioBusinessResolver.service.js", () => ({
  __esModule: true,
  resolveBusinessByTwilioNumber: jest.fn(),
  resolveBusinessFromWebhookPhones: jest.fn(),
}));
jest.mock("../../src/services/messaging/smsConversation.service.js", () => ({
  __esModule: true,
  getOrCreateSmsLeadAndConversation: jest.fn(),
}));
jest.mock("../../src/services/messaging/smsProcessingQueue.service.js", () => ({
  __esModule: true,
  enqueueInboundSmsJob: jest.fn(),
}));
jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({
  __esModule: true,
  classifyInboundSmsCommand: jest.fn(),
  processInboundSmsCommand: jest.fn(),
}));
jest.mock("../../src/services/messaging/inboundSmsLifecycle.service.js", () => ({
  __esModule: true,
  runInboundSmsLifecycleAfterClaim: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/services/webhooks/twilioWebhookEvent.service.js", () => ({
  __esModule: true,
  claimTwilioWebhookEvent: jest.fn(),
  completeTwilioWebhookEvent: jest.fn(),
  failTwilioWebhookEvent: jest.fn(),
}));
jest.mock("../../src/helpers/ai/aiGuardrails.js", () => ({
  __esModule: true,
  evaluateDeterministicInboundGuardrails: jest.fn(),
}));
jest.mock("../../src/helpers/businessFeatures.js", () => ({
  __esModule: true,
  isBusinessFeatureEnabled: jest.fn(),
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {
    createCustomerReplyAlert: jest.fn(),
    createAIReviewAlert: jest.fn(),
    createSystemAlert: jest.fn(),
  },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitMessageCreated: jest.fn(),
    emitMessageUpdated: jest.fn(),
    emitConversationUpdated: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalEvent: jest.fn(),
  logOperationalError: jest.fn(),
}));
jest.mock("../../src/services/messaging/smsMedia.service.js", () => ({
  __esModule: true,
  parseInboundTwilioMedia: jest.fn(() => []),
  buildMediaOnlyAcknowledgement: jest.fn(),
}));
jest.mock("../../src/helpers/twilioEventKey.js", () => ({
  __esModule: true,
  buildTwilioEventIdentity: jest.fn(() => ({
    eventType: "inbound_sms",
    eventKey: "inbound_sms:SM_FULL_FLOW",
    providerEventId: "SM_FULL_FLOW",
  })),
  getTwilioStatusEventType: jest.fn(),
}));
jest.mock("../../src/services/messaging/smsCompliance.service.js", () => {
  const actual = jest.requireActual(
    "../../src/services/messaging/smsCompliance.service.js",
  );
  return {
    __esModule: true,
    ...actual,
    normalizeSmsPhone: jest.fn((value) => value),
  };
});
jest.mock("../../src/services/messaging/smsDeliveryStatus.service.js", () => ({
  __esModule: true,
  processTwilioMessageStatus: jest.fn(),
}));
jest.mock("../../src/services/messaging/manualSmsPolicy.service.js", () => ({
  __esModule: true,
  evaluateManualSmsPolicy: jest.fn(),
}));
jest.mock("../../src/voice/smsRecoveryVoicePrompt.service.js", () => ({
  __esModule: true,
  buildSmsRecoveryVoicePrompt: jest.fn(),
}));

const leanQuery = (value) => ({
  sort: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const createResponse = () => {
  const res = { type: jest.fn(), status: jest.fn(), send: jest.fn() };
  res.type.mockReturnValue(res);
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
};

const business = {
  _id: "business-1",
  businessName: "Atlanta Pro Plumbing",
  businessType: "plumbing",
  phone: "+14045552202",
  features: { aiQualificationEnabled: true },
};
const lead = {
  _id: "lead-1",
  customerName: "Missed Call Lead",
  phone: "+14045558258",
  serviceNeeded: "Unknown",
};
const conversation = {
  _id: "conversation-1",
  lead: lead._id,
  customerPhone: "+14045558258",
  status: "open",
  aiEnabled: true,
  humanTakeover: false,
};
const inboundMessage = {
  _id: "message-in-1",
  business: business._id,
  conversation: conversation._id,
  lead: lead._id,
  body: "I have a leaking faucet",
  providerMessageId: "SM_FULL_FLOW",
};

beforeEach(() => {
  jest.clearAllMocks();
  // CALLBACKIQ_FULL_FLOW_GUARDRAIL_DEFAULT
  evaluateDeterministicInboundGuardrails.mockReturnValue({
    handled: false,
    alertPriority: "medium",
    riskFlags: [],
  });
  resolveBusinessByTwilioNumber.mockResolvedValue(business);
  claimTwilioWebhookEvent.mockResolvedValue({
    claimed: true,
    event: { _id: "event-1", business: business._id },
  });
  completeTwilioWebhookEvent.mockResolvedValue({});
  getOrCreateSmsLeadAndConversation.mockResolvedValue({ lead, conversation });
  Message.findOneAndUpdate.mockResolvedValue(inboundMessage);

  // CALLBACKIQ_FULL_FLOW_CLASSIFIER_DEFAULT
  classifyInboundSmsCommand.mockReturnValue({
    handled: false,
    action: "",
    providerManaged: false,
    softOptOut: false,
    keyword: "I HAVE A LEAKING FAUCET",
    optOutType: "",
  });
  processInboundSmsCommand.mockResolvedValue({ handled: false });
  enqueueInboundSmsJob.mockResolvedValue({ _id: "job-1" });
  isBusinessFeatureEnabled.mockReturnValue(true);
  AlertService.createCustomerReplyAlert.mockResolvedValue({});
});

test("missed-call customer reply is acknowledged immediately and queued for durable AI processing", async () => {
  const req = {
    body: {
      From: "+14045558258",
      To: "+14045552202",
      Body: "I have a leaking faucet",
      MessageSid: "SM_FULL_FLOW",
      NumMedia: "0",
    },
  };
  const res = createResponse();

  await handleInboundSmsWebhook(req, res);

  expect(enqueueInboundSmsJob).toHaveBeenCalledWith({
    businessId: business._id,
    inboundMessageId: inboundMessage._id,
    conversationId: conversation._id,
    leadId: lead._id,
    providerMessageId: "SM_FULL_FLOW",
  });
  expect(logOperationalEvent).toHaveBeenCalledWith(
    "twilio.sms.ai_queued",
    expect.objectContaining({ conversationId: conversation._id }),
  );
  expect(completeTwilioWebhookEvent).toHaveBeenCalledWith(
    "event-1",
    expect.objectContaining({ statusCode: 200 }),
  );
  expect(res.status).toHaveBeenCalledWith(200);
});

test("the queued job generates and persists the AI reply exactly once", async () => {
  Business.findById.mockResolvedValue(business);
  Message.findById.mockResolvedValue(inboundMessage);
  Conversation.findById.mockResolvedValue(conversation);
  Lead.findById.mockResolvedValue(lead);
  Db.getMessagesForAI.mockResolvedValue([inboundMessage]);
  evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: false });
  isBusinessFeatureEnabled.mockReturnValue(true);
  generateAIReplyResult.mockResolvedValue({
    decision: "reply",
    reply: "Got it — a leaking faucet. What is the service address?",
    messageCategory: "service_request",
    serviceNeeded: "Leaking faucet repair",
    urgency: "medium",
    leadQualityScore: 62,
  });
  Lead.findByIdAndUpdate.mockResolvedValue({
    ...lead,
    serviceNeeded: "Leaking faucet repair",
  });
  const queuedOutbound = {
    _id: "message-out-1",
    business: business._id,
    inReplyToMessage: inboundMessage._id,
    providerMessageId: "",
    status: "queued",
    metadata: {},
  };
  const claimedOutbound = {
    ...queuedOutbound,
    deliveryAttemptedAt: new Date(),
  };
  const sentOutbound = {
    ...claimedOutbound,
    providerMessageId: "SM_REPLY_1",
    status: "queued",
    deliveryStatus: "queued",
  };
  Message.findOne
    .mockReturnValueOnce(leanQuery(null))
    .mockResolvedValueOnce(null);
  Message.find
    .mockReturnValueOnce(leanQuery([inboundMessage]))
    .mockReturnValueOnce(leanQuery([]));
  Message.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Message.create.mockResolvedValue(queuedOutbound);
  Message.findOneAndUpdate.mockResolvedValue(claimedOutbound);
  Message.findByIdAndUpdate.mockResolvedValue(sentOutbound);
  sendSms.mockResolvedValue({
    sid: "SM_REPLY_1",
    status: "queued",
    suppressed: false,
    body: "Got it — a leaking faucet. What is the service address?",
    encoding: "UCS-2",
    segmentCount: 1,
  });
  Conversation.findByIdAndUpdate.mockResolvedValue({
    ...conversation,
    lastMessage: "Got it — a leaking faucet. What is the service address?",
  });

  const result = await processInboundSmsJob({
    _id: "job-1",
    business: business._id,
    inboundMessage: inboundMessage._id,
    conversation: conversation._id,
    lead: lead._id,
  });

  expect(generateAIReplyResult).toHaveBeenCalledWith(
    expect.objectContaining({
      business,
      lead,
      customerMessage: "I have a leaking faucet",
    }),
  );
  expect(sendSms).toHaveBeenCalledTimes(1);
  expect(sendSms).toHaveBeenCalledWith(
    expect.objectContaining({
      to: conversation.customerPhone,
      directResponse: true,
      source: "inbound_sms_reply",
    }),
  );
  expect(result).toMatchObject({ sent: true, outboundMessageId: "message-out-1" });
  expect(logOperationalEvent).toHaveBeenCalledWith(
    "twilio.sms.reply_sent",
    expect.objectContaining({ providerMessageId: "SM_REPLY_1" }),
  );
});
