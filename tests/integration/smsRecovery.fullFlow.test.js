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
    createHumanHandoffAlert: jest.fn(),
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


describe("completed manual intake uses the durable staff handoff", () => {
  let activeLead;
  let activeConversation;
  let activeInbound;
  const job = { _id: "job-1", business: business._id, inboundMessage: "message-in-1", conversation: conversation._id, lead: lead._id };
  beforeEach(() => {
    activeLead = { ...lead, serviceNeeded: "Kitchen sink clog and dishwasher leak", urgency: "high", address: "123 Main St, Atlanta GA 30303", preferredAppointmentTime: "" };
    activeConversation = { ...conversation, orchestration: {}, bookingState: { status: "not_started" } };
    activeInbound = { ...inboundMessage, direction: "inbound", body: "Wednesday at 9 AM" };
    Business.findById.mockResolvedValue(business);
    Lead.findById.mockResolvedValue(activeLead);
    Message.findById.mockResolvedValue(activeInbound);
    Conversation.findById.mockImplementation(async () => activeConversation);
    Conversation.findByIdAndUpdate.mockImplementation(async (_id, update) => {
      for (const [key, value] of Object.entries(update?.$set || {})) {
        const parts = key.split(".");
        let cursor = activeConversation;
        for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
        cursor[parts.at(-1)] = value;
      }
      return activeConversation;
    });
    Lead.findByIdAndUpdate.mockImplementation(async (_id, updates) => Object.assign(activeLead, updates));
    Db.getMessagesForAI.mockResolvedValue([activeInbound]);
    Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue(null);
    Message.find.mockReset().mockReturnValueOnce(leanQuery([activeInbound])).mockReturnValue(leanQuery([]));
    Message.updateMany.mockResolvedValue({ modifiedCount: 0 });
    const outbound = { _id: "message-out-intake", business: business._id, inReplyToMessage: activeInbound._id, status: "queued", metadata: {} };
    Message.create.mockResolvedValue(outbound);
    Message.findOneAndUpdate.mockResolvedValue({ ...outbound, deliveryAttemptedAt: new Date() });
    Message.findByIdAndUpdate.mockResolvedValue({ ...outbound, providerMessageId: "SM_INTAKE_ACK" });
    sendSms.mockResolvedValue({ sid: "SM_INTAKE_ACK", status: "queued" });
    AlertService.createHumanHandoffAlert.mockResolvedValue({ _id: "intake-alert" });
    generateAIReplyResult.mockResolvedValue({ decision: "send_fixed_response", actionType: "send_fixed_response", messageCategory: "appointment_preference", reply: "I've noted Wednesday at 9 AM as your preference.", preferredAppointmentTime: "Wednesday at 9 AM", serviceNeeded: activeLead.serviceNeeded, urgency: "high", guardrail: { usedFallback: false } });
  });

  test("saves all details and the staff alert before acknowledging; does not pretend staff took over", async () => {
    const result = await processInboundSmsJob(job);
    expect(result.handoffStatus).toBe("acknowledged");
    expect(activeConversation.orchestration.handoffReason).toBe("intake_complete");
    expect(activeConversation.humanTakeover).toBe(false);
    expect(activeLead.preferredAppointmentTime).toBe("Wednesday at 9 AM");
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ lead: expect.objectContaining({ serviceNeeded: expect.stringMatching(/sink.*dishwasher/), address: expect.any(String), urgency: "high", preferredAppointmentTime: "Wednesday at 9 AM" }) }));
    expect(Lead.findByIdAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]);
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
    const sent = sendSms.mock.calls[0][0];
    expect(sent.body).toMatch(/sent your service details/);
    expect(sent.body).toMatch(/pause automated intake/);
    expect(sent.body).not.toMatch(/they.ll text|will call|will confirm|will contact/i);
  });

  test("an alert write failure prevents a false acknowledgement and the retry reuses the handoff", async () => {
    AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error("alert storage unavailable"));
    await expect(processInboundSmsJob(job)).rejects.toThrow("alert storage unavailable");
    expect(sendSms).not.toHaveBeenCalled();
    expect(activeConversation.orchestration.handoffStatus).toBe("pending_ack");
    Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue(null);
    Message.find.mockReset().mockReturnValueOnce(leanQuery([activeInbound])).mockReturnValue(leanQuery([]));
    const reply = await processInboundSmsJob(job);
    expect(reply.sent).toBe(true);
    expect(generateAIReplyResult).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  test("does not complete intake while the service address is missing", async () => {
    activeLead.address = "";
    await processInboundSmsJob(job);
    expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
    expect(activeConversation.orchestration.handoffReason).not.toBe("intake_complete");
  });

  test.each(["Can I be added to a wait list?", "Is there an emergency time?"])("routes a follow-up to staff without restarting intake: %s", async text => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffStatus: "acknowledged", handoffInboundMessage: "earlier-message" };
    activeLead.preferredAppointmentTime = "Wednesday at 9 AM";
    activeInbound.body = text;
    const result = await processInboundSmsJob(job);
    expect(result.decision).toBe("queued_for_team");
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ customerMessage: text }));
    expect(generateAIReplyResult).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
    expect(activeLead.preferredAppointmentTime).toBe("Wednesday at 9 AM");
  });

  test("immediate safety instructions still reach the customer after completed intake", async () => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffStatus: "acknowledged", handoffInboundMessage: "earlier-message" };
    activeInbound.body = "I smell gas. When will someone call?";
    evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true, category: "emergency", reply: "Leave the area and call emergency services.", riskFlags: ["safety_hazard"] });
    const result = await processInboundSmsJob(job);
    expect(result.sent).toBe(true);
    expect(sendSms.mock.calls[0][0].body).toMatch(/Leave the area/);
    expect(generateAIReplyResult).not.toHaveBeenCalled();
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ urgency: "emergency" }) }));
  });
});
