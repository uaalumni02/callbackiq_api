jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn().mockResolvedValue({ supported: null, reason: 'service_area_not_configured' }) }));
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
import EligibilityCatalog from '../../src/models/serviceOffering.js';
import EligibilityOperations from '../../src/models/businessOperationsSettings.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
beforeEach(() => {
  EligibilityCatalog.find = jest.fn(() => catalogQuery([approvedOffering('service-1', 'plumbing', ['dishwasher'])]));
  EligibilityOperations.findOne.mockReturnValue(catalogQuery({ serviceEligibilityPolicy: { catalogComplete: true } }));
});
import { getApprovedServiceEstimate } from "../../src/services/booking/approvedServiceEstimate.service.js";
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

jest.mock("../../src/services/booking/approvedServiceEstimate.service.js", () => ({ getApprovedServiceEstimate: jest.fn().mockResolvedValue("") }));
jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { findById: jest.fn(), findOne: jest.fn(), findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { findById: jest.fn(), findByIdAndUpdate: jest.fn(), findOneAndUpdate: jest.fn(() => ({ lean: async () => null })) },
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
  ...jest.requireActual("../../src/helpers/ai/aiGuardrails.js"),
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
  safeConsole: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
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
  delete lead.serviceEligibility;
  delete conversation.serviceEligibility;
  jest.clearAllMocks();
  getApprovedServiceEstimate.mockResolvedValue("");
  Conversation.findOne.mockImplementation(({ _id }) => Conversation.findById(_id));
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
    Lead.findByIdAndUpdate.mockImplementation(async (_id, updates) => Object.assign(activeLead, updates.$set || updates));
    Db.getMessagesForAI.mockResolvedValue([activeInbound]);
    Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue(null);
    Message.find.mockReset().mockReturnValueOnce(leanQuery([activeInbound])).mockReturnValue(leanQuery([]));
    Message.updateMany.mockResolvedValue({ modifiedCount: 0 });
    const outbound = { _id: "message-out-intake", business: business._id, inReplyToMessage: activeInbound._id, status: "queued", metadata: {} };
    Message.create.mockResolvedValue(outbound);
    Message.findOneAndUpdate.mockResolvedValue({ ...outbound, deliveryAttemptedAt: new Date() });
    Message.findByIdAndUpdate.mockResolvedValue({ ...outbound, providerMessageId: "SM_INTAKE_ACK" });
    sendSms.mockResolvedValue({ sid: "SM_INTAKE_ACK", status: "queued" });
    AlertService.createHumanHandoffAlert.mockResolvedValue({ alert: { _id: "intake-alert" } });
    generateAIReplyResult.mockResolvedValue({ decision: "send_fixed_response", actionType: "send_fixed_response", intakeReady: true, messageCategory: "appointment_preference", reply: "I've noted Wednesday at 9 AM as your preference.", preferredAppointmentTime: "Wednesday at 9 AM", serviceNeeded: activeLead.serviceNeeded, urgency: "high", guardrail: { usedFallback: false } });
  });


  test.each([false, true])('coverage review after completed intake persists an alert before reply (failure=%s)', async fail => {
    activeConversation.orchestration = { handoffReason: 'intake_complete', handoffInboundMessage: 'previous' };
    activeConversation.conversationMemory = {};
    activeConversation.save = jest.fn().mockResolvedValue(null);
    activeLead.save = jest.fn().mockResolvedValue(null);
    activeInbound.body = 'Monday 8 am';
    if (fail) AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('review storage unavailable'));
    if (fail) {
      await expect(processInboundSmsJob(job)).rejects.toThrow('review storage unavailable');
      expect(sendSms).not.toHaveBeenCalled();
    } else {
      await processInboundSmsJob(job);
      expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.objectContaining({ qualificationReason: 'service_area_not_configured',
          handoff: expect.objectContaining({ required: true, reason: 'intake_unclear' }) }) }));
      expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
      expect(sendSms.mock.calls[0][0].body).toMatch(/preferred time/);
    }
  });

  test.each([undefined, false])('does not mark intake complete without explicit readiness: %s', async intakeReady => {
    generateAIReplyResult.mockResolvedValue({
      decision: 'send_fixed_response', actionType: 'send_fixed_response',
      messageCategory: 'service_request', intakeReady,
      reply: 'Is the toilet clogged, leaking, or not flushing?',
      preferredAppointmentTime: 'Wednesday at 9 AM',
      serviceNeeded: 'My toilet is broken', guardrail: { usedFallback: false },
    });
    await processInboundSmsJob(job);
    expect(activeConversation.orchestration.handoffReason).not.toBe('intake_complete');
    expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Is the toilet') }));
  });

  test('a safety message after intake updates its address before staff notification', async () => {
    activeConversation.orchestration = { handoffReason: 'intake_complete', handoffInboundMessage: 'previous' };
    activeInbound.body = 'Water is pouring through the ceiling! 56566 Road Way Atlanta GA 30323';
    evaluateDeterministicInboundGuardrails.mockImplementation(jest.requireActual('../../src/helpers/ai/aiGuardrails.js').evaluateDeterministicInboundGuardrails);
    await processInboundSmsJob(job);
    expect(activeLead.address).toBe('56566 Road Way Atlanta GA 30323');
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ lead: expect.objectContaining({ address: activeLead.address, urgency: 'emergency' }) }));
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
  });

  test.each([
    { decision: 'no_reply', actionType: 'no_reply', messageCategory: 'service_details', reply: '', guardrail: { skipAI: false } },
    { decision: 'send', actionType: 'confirm_booking', messageCategory: 'appointment_preference', reply: 'You are booked.', guardrail: { skipAI: false } },
    { decision: 'send_fixed_response', messageCategory: 'unknown', reply: 'Fallback', guardrail: { skipAI: false, reason: 'ai_pipeline_error', usedFallback: true } },
  ])('unusable model result becomes a persisted handoff before customer delivery: %j', async candidate => {
    generateAIReplyResult.mockResolvedValue(candidate);
    await processInboundSmsJob(job);
    expect(activeConversation.orchestration.handoffReason).toBe('intake_unclear');
    expect(activeConversation.humanTakeover).toBe(false);
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
    expect(sendSms.mock.calls[0][0].body).not.toMatch(/you are booked/i);
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({
      workflowDecision: expect.objectContaining({ action: 'staff_review', version: 1 }) }) }));
    expect(Message.updateOne).toHaveBeenCalledWith({ _id: activeInbound._id, business: business._id },
      { $set: { 'metadata.workflowDecision': expect.objectContaining({ action: 'staff_review' }) } });
  });

  test('a failed staff-task write prevents a fallback promise from being sent', async () => {
    generateAIReplyResult.mockResolvedValue({ decision: 'no_reply', messageCategory: 'unknown', guardrail: { skipAI: false } });
    AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('staff task unavailable'));
    await expect(processInboundSmsJob(job)).rejects.toThrow('staff task unavailable');
    expect(sendSms).not.toHaveBeenCalled();
    expect(activeConversation.orchestration.handoffStatus).toBe('pending_ack');
  });

  test('an address supplied with a confirmation question is persisted without changing the existing appointment', async () => {
    activeInbound.body = 'My address is 456 Oak St, Atlanta GA 30303. When will the appointment be confirmed?';
    activeConversation.bookingState = { status: 'pending_business_confirmation', appointment: 'appointment-1' };
    // The reply pipeline supplies request facts; this test exercises the actual
    // processor's persistence, staff routing and delivery order.
    generateAIReplyResult.mockResolvedValue({ decision: 'send_fixed_response', actionType: 'send_fixed_response',
      messageCategory: 'appointment_status', reply: 'The appointment is still awaiting business approval.',
      address: '456 Oak St, Atlanta GA 30303', guardrail: { skipAI: true } });
    await processInboundSmsJob(job);
    expect(activeLead.address).toContain('456 Oak St');
    expect(activeConversation.bookingState).toMatchObject({ status: 'pending_business_confirmation', appointment: 'appointment-1' });
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({
      lead: expect.objectContaining({ address: expect.stringContaining('456 Oak St') }),
      result: expect.objectContaining({ handoff: expect.objectContaining({ required: true, reason: 'scheduling_review' }) }) }));
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
  });

  test('real compound reply pipeline keeps selection, callback and approval through final SMS dispatch', async () => {
    activeLead.save = jest.fn(async () => activeLead);
    activeConversation.save = jest.fn(async () => activeConversation);
    const startAt = new Date(Date.now() + 3 * 86400000);
    activeConversation.bookingState = { status: 'offering_slots', expiresAt: new Date(Date.now() + 600000),
      offeredSlots: [{ startAt, endAt: new Date(startAt.getTime() + 3600000) }] };
    activeInbound.body = 'That time works for me. Please have someone call me at this number. Can you guarantee my appointment?';
    generateAIReplyResult.mockImplementation(jest.requireActual('../../src/services/aiReplyService.js').generateAIReplyResult);
    await processInboundSmsJob(job);
    const body = sendSms.mock.calls[0][0].body;
    expect(body).toMatch(/Requested/);
    expect(body).toMatch(/not a confirmed appointment/i);
    expect(body).toMatch(/Callback requested/);
    expect(activeLead.preferredAppointmentTime).toBeTruthy();
    expect(activeConversation.conversationMemory.recoveryIntake.compoundTurn.selectedSlot.startAt).toEqual(startAt);
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({
      lead: expect.objectContaining({ preferredAppointmentTime: activeLead.preferredAppointmentTime }),
      result: expect.objectContaining({ handoff: expect.objectContaining({ callbackRequested: true, reason: 'scheduling_review' }) }) }));
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
    expect(body.length).toBeLessThanOrEqual(320);
  });

  test('same-day scheduling review creates the staff alert before the SMS acknowledgement', async () => {
    activeInbound.body = 'Can someone come today?';
    generateAIReplyResult.mockResolvedValue({ decision: 'send_fixed_response', actionType: 'human_handoff', messageCategory: 'appointment_preference',
      reply: 'Your requested timing is saved for team review.', serviceNeeded: activeLead.serviceNeeded, address: activeLead.address,
      preferredAppointmentTime: 'today', handoff: { required: true, reason: 'scheduling_review' }, shouldAlertOwner: true });
    await processInboundSmsJob(job);
    expect(activeConversation.orchestration.handoffReason).toBe('scheduling_review');
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ handoff: expect.objectContaining({ reason: 'scheduling_review' }) }) }));
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
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
    expect(sent.body).toMatch(/service request is saved/);
    expect(sent.body).not.toMatch(/pause automated intake/);
    expect(sent.body).not.toMatch(/they.ll text|will call|will confirm|will contact/i);
  });

  test.each([
    ["humanTakeover", true, "human_takeover"],
    ["status", "closed", "conversation_inactive"],
    ["status", "archived", "conversation_inactive"],
    ["aiEnabled", false, "conversation_ai_disabled"],
  ])("suppresses the prepared reply when %s changes during processing", async (field, value, reason) => {
    AlertService.createHumanHandoffAlert.mockImplementationOnce(async () => {
      activeConversation[field] = value;
      return { alert: { _id: "intake-alert" } };
    });
    Message.findByIdAndUpdate.mockImplementation(async (_id, update) => ({ _id, ...update }));
    const result = await processInboundSmsJob(job);
    expect(result).toMatchObject({ sent: false, suppressed: true });
    expect(sendSms).not.toHaveBeenCalled();
    expect(Message.findByIdAndUpdate).toHaveBeenCalledWith("message-out-intake",
      expect.objectContaining({ status: "suppressed", deliveryAttemptedAt: null,
        metadata: expect.objectContaining({ suppressionReason: reason }) }), expect.any(Object));
    expect(Conversation.findOne).toHaveBeenCalledWith({ _id: conversation._id, business: business._id });
  });

  test("record mismatch suppresses dispatch and creates an actionable staff alert", async () => {
    AlertService.createHumanHandoffAlert.mockImplementationOnce(async () => {
      activeConversation.lead = "another-lead";
      return { alert: { _id: "intake-alert" } };
    });
    Message.findByIdAndUpdate.mockImplementation(async (_id, update) => ({ _id, ...update }));
    const result = await processInboundSmsJob(job);
    expect(result).toMatchObject({ sent: false, suppressed: true });
    expect(sendSms).not.toHaveBeenCalled();
    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(expect.objectContaining({
      title: "Customer SMS reply blocked by record mismatch", priority: "high",
      metadata: expect.objectContaining({ reason: "automation_context_changed" }),
    }));
    expect(logOperationalEvent).toHaveBeenCalledWith("twilio.sms.reply_suppressed",
      expect.objectContaining({ reason: "automation_context_changed" }));
  });

  test("replays a suppressed turn without sending or declaring uncertain delivery", async () => {
    Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue({
      _id: "previously-suppressed", status: "suppressed", providerMessageId: "",
      deliveryAttemptedAt: new Date(),
    });
    const result = await processInboundSmsJob(job);
    expect(result).toMatchObject({ sent: false, suppressed: true, outboundMessageId: "previously-suppressed" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(AlertService.createSystemAlert).not.toHaveBeenCalled();
  });

  test("preserves uncertain provider outcome with the original network error code", async () => {
    sendSms.mockRejectedValueOnce(Object.assign(new Error("provider socket timeout"), {
      code: "ETIMEDOUT", deliveryUncertain: true,
    }));
    const result = await processInboundSmsJob(job);
    expect(result).toMatchObject({ sent: false, handoffStatus: "delivery_uncertain" });
    expect(Message.findByIdAndUpdate).toHaveBeenCalledWith("message-out-intake",
      expect.objectContaining({ deliveryUncertain: true, deliveryAttemptedAt: expect.any(Date),
        deliveryErrorCode: "ETIMEDOUT" }));
  });

  test.each([{ status: "closed" }, { status: "archived" }, { aiEnabled: false }])(
    "handoff status questions do not bypass ownership: %p", async (state) => {
      Object.assign(activeConversation, state, { orchestration: { handoffStatus: "acknowledged" } });
      activeInbound.body = "Did you receive my callback request?";
      const result = await processInboundSmsJob(job);
      expect(result).toMatchObject({ decision: "skipped", reason: "ai_ineligible" });
      expect(sendSms).not.toHaveBeenCalled();
      expect(generateAIReplyResult).not.toHaveBeenCalled();
    },
  );

  describe('customer contact controls across the conversation lifecycle', () => {
    function arrangeContact(text = 'Call me', overrides = {}) {
      activeInbound.body = text;
      activeLead.preferredAppointmentTime = '2026-10-01 at 10:00';
      activeConversation.orchestration = { handoffReason: 'intake_complete', handoffInboundMessage: 'earlier', handoffStatus: 'acknowledged' };
      activeConversation.conversationMemory = { recoveryIntake: { review: { status: 'queued', alertId: 'original-review' }, date: '2026-10-01', time: '10:00' } };
      Object.assign(activeConversation, overrides);
    }
    test.each([
      ['Call me', {}], ['Please call me back', {}], ['Can someone call me?', {}],
      ['I want to speak to a person', {}], ['Call me', { humanTakeover: true, aiEnabled: false }],
      ['Call me', { orchestration: {} }],
      ['Call me', { bookingState: { status: 'booked', appointment: 'appointment-1' } }],
      ['Call me', { serviceEligibility: { decision: 'unsupported' } }],
    ])('durably records %s without changing facts or ownership (%p)', async (text, overrides) => {
      arrangeContact(text, overrides);
      const before = JSON.stringify({ lead: activeLead, booking: activeConversation.bookingState,
        human: activeConversation.humanTakeover, ai: activeConversation.aiEnabled });
      const result = await processInboundSmsJob(job);
      expect(result).toMatchObject({ decision: 'contact_control', sent: true });
      expect(generateAIReplyResult).not.toHaveBeenCalled();
      expect(JSON.stringify({ lead: activeLead, booking: activeConversation.bookingState,
        human: activeConversation.humanTakeover, ai: activeConversation.aiEnabled })).toBe(before);
      expect(sendSms.mock.calls[0][0].body).toMatch(/saved for (?:the team|review)/);
      expect(sendSms.mock.calls[0][0].body).not.toMatch(/appointment is not confirmed|keep helping|will call|will respond/i);
      expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
      expect(activeConversation.conversationMemory.recoveryIntake.contactControl.request.alertId).toBe('intake-alert');
      expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.objectContaining({ handoff: expect.objectContaining({ callbackRequested: /call/i.test(text) }) }),
        lead: expect.objectContaining({ preferredAppointmentTime: '2026-10-01 at 10:00' }),
      }));
    });
    test.each(['Did you get my text?', 'Did you receive my message?', 'Are you still there?'])('acknowledges %s during staff ownership without AI', async text => {
      arrangeContact(text, { humanTakeover: true, aiEnabled: false });
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: true, decision: 'contact_control' });
      expect(sendSms.mock.calls[0][0].body).toMatch(/your message was received/i);
      expect(sendSms.mock.calls[0][0].body).not.toMatch(/saved for review|team received|team has read/i);
      expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
      expect(generateAIReplyResult).not.toHaveBeenCalled();
      expect(activeConversation.humanTakeover).toBe(true);
      expect(activeConversation.aiEnabled).toBe(false);
    });
    test.each(['Did you get my text?', 'Call me'])('enqueues %s during staff takeover at the webhook', async text => {
      arrangeContact(text, { humanTakeover: true, aiEnabled: false });
      getOrCreateSmsLeadAndConversation.mockResolvedValue({ lead: activeLead, conversation: activeConversation });
      const req = { body: { From: activeConversation.customerPhone, To: business.phone, Body: text, MessageSid: 'SM_CONTROL' } };
      const res = { type: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis(), send: jest.fn() };
      await handleInboundSmsWebhook(req, res);
      expect(enqueueInboundSmsJob).toHaveBeenCalled();
    });
    test('does not restart AI for ordinary staff-owned follow-up', async () => {
      arrangeContact('Please change my address to 12 Oak St', { humanTakeover: true, aiEnabled: false });
      expect(await processInboundSmsJob(job)).toMatchObject({ reason: 'ai_ineligible' });
      expect(sendSms).not.toHaveBeenCalled();
      expect(generateAIReplyResult).not.toHaveBeenCalled();
    });
    test('callback followed by receipt check preserves Thursday preference and has no silent turn', async () => {
      arrangeContact();
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: true });
      activeInbound.body = 'Did you get my text?';
      activeInbound._id = 'message-in-2';
      Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue(null);
      Message.find.mockReset().mockReturnValueOnce(leanQuery([activeInbound])).mockReturnValue(leanQuery([]));
      expect(await processInboundSmsJob({ ...job, inboundMessage: activeInbound._id })).toMatchObject({ sent: true });
      expect(sendSms).toHaveBeenCalledTimes(2);
      expect(sendSms.mock.calls[1][0].body).toMatch(/message was received.*saved for review/i);
      expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledTimes(1);
      expect(activeLead.preferredAppointmentTime).toBe('2026-10-01 at 10:00');
      expect(activeConversation.orchestration.handoffReason).toBe('intake_complete');
    });
    test('callback plus a receipt check coalesced into one turn receives one callback acknowledgement', async () => {
      arrangeContact('Call me\nDid you get my text?');
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: true });
      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(sendSms.mock.calls[0][0].body).toMatch(/callback request is saved/);
    });
    test('callback retry after provider acceptance does not resend', async () => {
      arrangeContact();
      Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue({ _id: 'already-sent', providerMessageId: 'SM_ALREADY' });
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: true, outboundMessageId: 'already-sent' });
      expect(sendSms).not.toHaveBeenCalled();
      expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ messageId: activeInbound._id, providerMessageId: activeInbound.providerMessageId }));
    });
    test('callback task failure never produces a false saved acknowledgement', async () => {
      arrangeContact();
      AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('contact write failed'));
      await expect(processInboundSmsJob(job)).rejects.toThrow('contact write failed');
      expect(sendSms).not.toHaveBeenCalled();
      expect(activeConversation.conversationMemory.recoveryIntake.contactControl).toBeUndefined();
    });
    test('callback projection failure remains retryable before sending', async () => {
      arrangeContact();
      Conversation.findByIdAndUpdate.mockResolvedValueOnce(null);
      await expect(processInboundSmsJob(job)).rejects.toMatchObject({ code: 'STAFF_ACTION_NOT_SAVED' });
      expect(sendSms).not.toHaveBeenCalled();
    });
    test('receipt acknowledgement is throttled independently from the callback acknowledgement', async () => {
      arrangeContact('Did you get my text?');
      activeConversation.conversationMemory.recoveryIntake.contactControl = {
        request: { alertId: 'callback-alert' }, receiptReply: { at: new Date(), inboundMessageId: 'previous-receipt' },
      };
      expect(await processInboundSmsJob(job)).toMatchObject({ reason: 'human_handoff_status_throttled' });
      expect(sendSms).not.toHaveBeenCalled();
    });
    test('same receipt retry reaches durable outbound deduplication despite throttle', async () => {
      arrangeContact('Did you get my text?');
      activeConversation.conversationMemory.recoveryIntake.contactControl = {
        receiptReply: { at: new Date(), inboundMessageId: activeInbound._id },
      };
      Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue({ _id: 'already-sent', providerMessageId: 'SM_ALREADY' });
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: true, outboundMessageId: 'already-sent' });
      expect(sendSms).not.toHaveBeenCalled();
    });
    test('provider uncertainty keeps the callback durable and does not promise delivery', async () => {
      arrangeContact();
      sendSms.mockRejectedValueOnce(Object.assign(new Error('timeout'), { deliveryUncertain: true }));
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: false });
      expect(activeConversation.conversationMemory.recoveryIntake.contactControl.request.alertId).toBe('intake-alert');
      expect(AlertService.createSystemAlert).toHaveBeenCalled();
    });
    test('consent suppression does not start the receipt throttle', async () => {
      arrangeContact('Did you get my text?');
      sendSms.mockResolvedValueOnce({ suppressed: true, reason: 'customer_opted_out' });
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: false, suppressed: true });
      expect(activeConversation.conversationMemory.recoveryIntake.contactControl?.receiptReply).toBeUndefined();
    });
    test('closure during callback persistence suppresses the acknowledgement at dispatch', async () => {
      arrangeContact();
      AlertService.createHumanHandoffAlert.mockImplementationOnce(async () => {
        activeConversation.status = 'closed'; return { alert: { _id: 'contact-alert' } };
      });
      Message.findByIdAndUpdate.mockImplementation(async (_id, update) => ({ _id, ...update }));
      expect(await processInboundSmsJob(job)).toMatchObject({ sent: false, suppressed: true });
      expect(sendSms).not.toHaveBeenCalled();
    });
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

  test.each([
    "I think my house is going to flood and I will have a catastrophe",
    "There is smoke coming from the electrical panel",
    "I smell gas in my house",
  ])("persists post-intake safety urgency and retains captured facts: %s", async text => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffStatus: "acknowledged", handoffInboundMessage: "earlier-message" };
    activeLead.urgency = "medium";
    activeLead.preferredAppointmentTime = "2026-09-09 at 14:00";
    activeInbound.body = text;
    const realGuardrails = jest.requireActual("../../src/helpers/ai/aiGuardrails.js");
    evaluateDeterministicInboundGuardrails.mockImplementation(realGuardrails.evaluateDeterministicInboundGuardrails);
    const result = await processInboundSmsJob(job);
    expect(result.sent).toBe(true);
    expect(activeLead.urgency).toBe("emergency");
    expect(activeConversation.conversationMemory.urgency).toBe("emergency");
    expect(activeLead.serviceNeeded).toBe("Kitchen sink clog and dishwasher leak");
    expect(activeLead.preferredAppointmentTime).toBe("2026-09-09 at 14:00");
    expect(activeConversation.orchestration.lastIntent).toBe("emergency");
    expect(Message.findByIdAndUpdate).toHaveBeenCalledWith(activeInbound._id, expect.objectContaining({ $set: expect.objectContaining({ aiOutcome: expect.objectContaining({ intent: "emergency", outcome: "queued_for_team" }) }) }));
    expect(sendSms.mock.calls[0][0].body).not.toMatch(/has been alerted|will follow up|will call|will contact/i);
    expect(AlertService.createHumanHandoffAlert.mock.invocationCallOrder[0]).toBeLessThan(sendSms.mock.invocationCallOrder[0]);
    expect(generateAIReplyResult).not.toHaveBeenCalled();
  });

  test("post-intake alert failure remains retryable and prevents the safety reply", async () => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffInboundMessage: "earlier-message" };
    activeInbound.body = "My house is flooding";
    evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true, category: "emergency", reply: "Stay safe." });
    AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error("alert storage unavailable"));
    await expect(processInboundSmsJob(job)).rejects.toThrow("alert storage unavailable");
    expect(activeLead.urgency).toBe("emergency");
    expect(sendSms).not.toHaveBeenCalled();
  });


  const tradeCases = [
    ["plumbing", "Bathtub drain repair", "My house is flooding", "Can you also check the kitchen tap?"],
    ["hvac", "AC repair", "No AC and dangerously hot with a newborn", "The AC is blowing warm air"],
    ["electrical", "Outlet repair", "The electrical panel is sparking", "Please install a smoke detector"],
    ["roofing", "Roof repair", "The roof is collapsing", "Several shingles are missing"],
    ["restoration", "Water damage restoration", "Water is pouring through the ceiling", "Please send an estimate for the old water stain"],
    ["garage_door", "Garage door repair", "Someone is trapped under the garage door", "The garage door will not open"],
    ["locksmith", "Lock repair", "A child is locked inside", "I need the front door lock replaced"],
    ["landscaping", "Tree trimming", "A tree fell onto my house", "Can you trim the hedges as well?"],
  ];
  test.each(tradeCases)("%s: distinguishes a routine follow-up from a safety escalation", async (trade, service, danger, routine) => {
    EligibilityCatalog.find.mockReturnValue(catalogQuery([approvedOffering('service-1', trade, ['smoke detector', 'hedges', 'tap', 'lock repair'])]));
    Business.findById.mockResolvedValue({ ...business, businessType: trade });
    activeLead.serviceNeeded = service; activeLead.urgency = "medium";
    activeLead.preferredAppointmentTime = "2026-09-09 at 14:00";
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffInboundMessage: "previous" };
    activeInbound.body = routine;
    const real = jest.requireActual("../../src/helpers/ai/aiGuardrails.js");
    evaluateDeterministicInboundGuardrails.mockImplementation(real.evaluateDeterministicInboundGuardrails);
    await processInboundSmsJob(job);
    expect(activeLead.urgency).not.toBe("emergency");
    if (trade === "restoration") expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("approved estimate") }));
    else expect(sendSms).not.toHaveBeenCalled();
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ customerMessage: routine }));
    expect(activeLead.serviceNeeded).toBe(service);
  });
  test.each(tradeCases)("%s: urgent follow-up is retained during staff takeover with no AI reply", async (trade, service, danger) => {
    EligibilityCatalog.find.mockReturnValue(catalogQuery([approvedOffering('service-1', trade, ['smoke detector', 'hedges', 'tap', 'lock repair'])]));
    Business.findById.mockResolvedValue({ ...business, businessType: trade });
    activeLead.serviceNeeded = service; activeLead.urgency = "medium";
    activeLead.preferredAppointmentTime = "2026-09-09 at 14:00";
    activeConversation.humanTakeover = true;
    activeInbound.body = danger;
    evaluateDeterministicInboundGuardrails.mockImplementation(jest.requireActual("../../src/helpers/ai/aiGuardrails.js").evaluateDeterministicInboundGuardrails);
    const result = await processInboundSmsJob(job);
    expect(result.reason).toBe("staff_safety_review");
    expect(activeLead.urgency).toBe("emergency");
    expect(activeLead.serviceNeeded).toBe(service);
    expect(activeLead.preferredAppointmentTime).toBe("2026-09-09 at 14:00");
    expect(activeConversation.humanTakeover).toBe(true);
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ urgency: "emergency" }) }));
    expect(sendSms).not.toHaveBeenCalled(); expect(generateAIReplyResult).not.toHaveBeenCalled();
  });
  test("unclear risk during staff takeover persists high priority without an emergency label or automatic reply", async () => {
    activeConversation.humanTakeover = true;
    activeLead.serviceNeeded = "sink clog"; activeLead.urgency = "medium";
    activeInbound.body = "An alarm is beeping";
    evaluateDeterministicInboundGuardrails.mockImplementation(jest.requireActual("../../src/helpers/ai/aiGuardrails.js").evaluateDeterministicInboundGuardrails);
    const result = await processInboundSmsJob(job);
    expect(result.reason).toBe("staff_safety_review");
    expect(activeLead.urgency).toBe("high");
    expect(activeLead.serviceNeeded).toBe("sink clog");
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ messageCategory: "service_request", urgency: "high", riskFlags: ["safety_clarification"] }) }));
    expect(sendSms).not.toHaveBeenCalled();
    expect(generateAIReplyResult).not.toHaveBeenCalled();
  });
  test.each(["Actually I need Thursday instead", "The address is wrong", "I need a price", "Do you cover my area?", "What does that mean?", "Thank you"])("preserves post-intake follow-up for staff: %s", async text => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffInboundMessage: "previous" };
    activeInbound.body = text; activeLead.preferredAppointmentTime = "2026-09-09 at 14:00";
    await processInboundSmsJob(job);
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ customerMessage: text }));
    expect(activeLead.preferredAppointmentTime).toBe("2026-09-09 at 14:00");
    expect(generateAIReplyResult).not.toHaveBeenCalled();
  });

  test("withdraws completed intake durably and acknowledges the withdrawal", async () => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffInboundMessage: "previous" };
    activeConversation.save = jest.fn().mockResolvedValue(null);
    activeLead.save = jest.fn().mockResolvedValue(null);
    AlertService.create = jest.fn().mockResolvedValue({ alert: { _id: "withdrawal-alert" } });
    activeInbound.body = "Please cancel that request";
    const response = await processInboundSmsJob(job);
    expect(response.sent).toBe(true);
    expect(sendSms.mock.calls[0][0].body).toMatch(/withdrawn/);
    expect(activeConversation.conversationMemory.recoveryIntake.withdrawnAt).toBeTruthy();
    expect(activeLead.status).toBe("lost");
    expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ actionRequired: true, title: "Customer withdrew service request" }));
    expect(generateAIReplyResult).not.toHaveBeenCalled();
  });

  test.each(tradeCases)("%s: pending staff review still answers an immediate-help question", async (trade, service) => {
    activeLead.serviceNeeded = service;
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffInboundMessage: "previous" };
    activeInbound.body = "What can I do about it for right now?";
    const response = await processInboundSmsJob(job);
    expect(response.sent).toBe(true);
    expect(sendSms.mock.calls[0][0].body).toMatch(/Avoid using/);
    expect(sendSms.mock.calls[0][0].body).not.toMatch(/repeat|needs to review|confirmed appointment/);
    expect(generateAIReplyResult).not.toHaveBeenCalled();
  });

  test('missing durable alert blocks customer acknowledgement', async () => {
    AlertService.createHumanHandoffAlert.mockResolvedValueOnce({});
    await expect(processInboundSmsJob(job)).rejects.toMatchObject({code:'STAFF_ACTION_NOT_SAVED'});
    expect(sendSms).not.toHaveBeenCalled();
  });

  test('review state write failure blocks acknowledgement and remains retryable', async () => {
    const original = Conversation.findByIdAndUpdate.getMockImplementation();
    Conversation.findByIdAndUpdate.mockImplementation(async (...args) => {
      if (args[1]?.$set?.['conversationMemory.recoveryIntake.review']) throw new Error('review projection failed');
      return original(...args);
    });
    await expect(processInboundSmsJob(job)).rejects.toThrow('review projection failed');
    expect(sendSms).not.toHaveBeenCalled();
    Conversation.findByIdAndUpdate.mockImplementation(original);
    Message.findOne.mockReset().mockReturnValueOnce(leanQuery(null)).mockResolvedValue(null);
    Message.find.mockReset().mockReturnValueOnce(leanQuery([activeInbound])).mockReturnValue(leanQuery([]));
    await expect(processInboundSmsJob(job)).resolves.toMatchObject({sent:true});
  });

  test("answers an approved price question after intake without making a booking", async () => {
    activeConversation.orchestration = { handoffReason: "intake_complete", handoffInboundMessage: "previous" };
    activeInbound.body = "How much will it cost?";
    getApprovedServiceEstimate.mockResolvedValue("The rough estimate is $150-$250. Final pricing depends on technician evaluation.");
    await processInboundSmsJob(job);
    expect(sendSms.mock.calls[0][0].body).toContain("$150-$250");
    expect(activeConversation.bookingState.status).toBe("not_started");
    expect(AlertService.createHumanHandoffAlert).toHaveBeenCalled();
    expect(generateAIReplyResult).not.toHaveBeenCalled();
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


test.each(["hvac", "electrical", "roofing", "restoration", "garage_door", "locksmith", "landscaping", "plumbing"])("%s webhook queues a safety observation despite staff takeover", async trade => {
  resolveBusinessByTwilioNumber.mockResolvedValue({ ...business, businessType: trade });
  getOrCreateSmsLeadAndConversation.mockResolvedValue({ lead, conversation: { ...conversation, humanTakeover: true, aiEnabled: false } });
  evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true, category: "emergency", riskFlags: ["safety_hazard"] });
  const req = { body: { From: lead.phone, To: business.phone, Body: "Someone is trapped", MessageSid: "SM_SAFETY", NumMedia: "0" } };
  await handleInboundSmsWebhook(req, createResponse());
  expect(enqueueInboundSmsJob).toHaveBeenCalled();
  expect(sendSms).not.toHaveBeenCalled();
});

test("webhook queues unclear risk for staff review while automation remains off", async () => {
  getOrCreateSmsLeadAndConversation.mockResolvedValue({ lead, conversation: { ...conversation, humanTakeover: true, aiEnabled: false } });
  evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true, category: "service_request", reason: "safety_clarification_required" });
  await handleInboundSmsWebhook({ body: { From: lead.phone, To: business.phone, Body: "An alarm is beeping", MessageSid: "SM_UNCLEAR", NumMedia: "0" } }, createResponse());
  expect(enqueueInboundSmsJob).toHaveBeenCalled();
  expect(sendSms).not.toHaveBeenCalled();
});
