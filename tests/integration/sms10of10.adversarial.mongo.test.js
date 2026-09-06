import request from "supertest";
import mongoose from "mongoose";

import app from "../../src/app.js";
import Alert from "../../src/models/alert.js";
import Business from "../../src/models/business.js";
import CommunicationRouteRateLimit from "../../src/models/communicationRouteRateLimit.js";
import ContactPreference from "../../src/models/contactPreference.js";
import Message from "../../src/models/message.js";
import SmsDeliveryReconciliationEvent from "../../src/models/smsDeliveryReconciliationEvent.js";
import SmsProcessingJob from "../../src/models/smsProcessingJob.js";
import WebhookEvent from "../../src/models/webhookEvent.js";

import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
  failTwilioWebhookEvent,
} from "../../src/services/webhooks/twilioWebhookEvent.service.js";
import {
  reconcileOrphanedInboundSmsJobs,
} from "../../src/services/messaging/smsProcessingQueue.service.js";
import {
  classifyInboundSmsCommand,
  getSmsPreference,
  optOutSms,
  processInboundSmsCommand,
} from "../../src/services/messaging/contactPreference.service.js";
import {
  sendIdempotentInboundSmsReply,
} from "../../src/services/messaging/idempotentInboundSmsReply.service.js";
import {
  processTwilioMessageStatus,
} from "../../src/services/messaging/smsDeliveryStatus.service.js";
import {
  drainSmsDeliveryReconciliationOnce,
} from "../../src/workers/smsDeliveryReconciliation.worker.js";
import {
  createCommunicationRouteRateLimit,
  resetCommunicationRouteRateLimits,
  twilioSmsFallbackWebhookRateLimit,
  twilioSmsWebhookRateLimit,
} from "../../src/middleware/twilio-webhook-rate-limit.js";
import {
  resetTwilioClient,
  sendSms,
  setBeforeSmsProviderSendHookForTests,
} from "../../src/services/twilioSmsService.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

const mockTwilioMessageCreate = jest.fn();

jest.mock("twilio", () => {
  const twilioMock = jest.fn(() => ({
    messages: {
      create: mockTwilioMessageCreate,
    },
  }));
  twilioMock.validateRequest = jest.fn(() => true);
  return twilioMock;
});

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.TWILIO_ACCOUNT_SID = "AC_SMS_10OF10";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-sms-10of10";
  await connectTestDB();

  await Promise.all([
    Alert.init(),
    CommunicationRouteRateLimit.init(),
    ContactPreference.init(),
    Message.init(),
    SmsDeliveryReconciliationEvent.init(),
    SmsProcessingJob.init(),
    WebhookEvent.init(),
  ]);
}, 30000);

beforeEach(() => {
  resetCommunicationRouteRateLimits();
  resetTwilioClient();
  mockTwilioMessageCreate.mockReset();
  mockTwilioMessageCreate.mockResolvedValue({
    sid: "SM_10OF10_SENT",
    status: "queued",
    to: "+14045559999",
    from: "+14045551234",
  });
});

afterEach(async () => {
  resetCommunicationRouteRateLimits();
  resetTwilioClient();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createBusiness = async (overrides = {}) =>
  Business.create({
    owner: new mongoose.Types.ObjectId(),
    businessName: "Atlanta Pro Plumbing",
    businessType: "plumbing",
    phone: "4045551234",
    trackingNumber: { provider: "twilio", status: "active" },
    estimatedJobValue: 1200,
    isActive: true,
    ...overrides,
  });

const webhookClaimInput = (businessId, sid = "SM_WEBHOOK_10OF10") => ({
  businessId,
  eventType: "inbound_sms",
  eventKey: `inbound_sms:${sid}`,
  providerEventId: sid,
  requestMetadata: {
    from: "+14045559999",
    to: "+14045551234",
  },
});

const makeInboundMessage = async ({
  businessId,
  providerMessageId,
  withLead = true,
  processingRequired = true,
}) => {
  const conversation = new mongoose.Types.ObjectId();
  const lead = withLead ? new mongoose.Types.ObjectId() : null;

  if (!withLead) {
    const raw = {
      business: businessId,
      conversation,
      direction: "inbound",
      from: "+14045559999",
      to: "+14045551234",
      body: "Need a plumber",
      provider: "twilio",
      providerMessageId,
      status: "received",
      deliveryStatus: "received",
      metadata: {
        processingRequired,
        processingEnqueuedAt: null,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await Message.collection.insertOne(raw);
    return { _id: result.insertedId, ...raw };
  }

  return Message.create({
    business: businessId,
    conversation,
    lead,
    direction: "inbound",
    from: "+14045559999",
    to: "+14045551234",
    body: "Need a plumber",
    provider: "twilio",
    providerMessageId,
    status: "received",
    deliveryStatus: "received",
    metadata: {
      processingRequired,
      processingEnqueuedAt: null,
    },
  });
};

const runMiddleware = (middleware, req) =>
  new Promise((resolve, reject) => {
    let statusCode = 200;
    let ended = false;

    const res = {
      set: jest.fn(),
      status(code) {
        statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      send() {
        ended = true;
        resolve({ next: false, statusCode });
        return this;
      },
      json() {
        ended = true;
        resolve({ next: false, statusCode });
        return this;
      },
    };

    Promise.resolve(
      middleware(req, res, () => {
        if (!ended) resolve({ next: true, statusCode });
      }),
    ).catch(reject);
  });

describe("CallBackIQ SMS 10/10 adversarial Mongo certification", () => {
  test("1. stale WebhookEvent owner cannot settle a reclaimed lease", async () => {
    const business = await createBusiness();
    const input = webhookClaimInput(business._id, "SM_STALE_OWNER");

    const first = await claimTwilioWebhookEvent(input);
    await WebhookEvent.updateOne(
      { _id: first.event._id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1) } },
    );

    const second = await claimTwilioWebhookEvent(input);
    expect(second.claimed).toBe(true);
    expect(second.reclaimed).toBe(true);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    const staleComplete = await completeTwilioWebhookEvent(first.event._id, {
      leaseToken: first.leaseToken,
      statusCode: 200,
      responseBody: "<Response></Response>",
    });
    expect(staleComplete).toBeNull();

    const staleFail = await failTwilioWebhookEvent(
      first.event._id,
      new Error("stale owner"),
      { leaseToken: first.leaseToken },
    );
    expect(staleFail).toBeNull();

    const winner = await completeTwilioWebhookEvent(second.event._id, {
      leaseToken: second.leaseToken,
      statusCode: 200,
      responseBody: "<Response></Response>",
    });
    expect(winner.status).toBe("completed");
  });

  test("2. crash after WebhookEvent claim can be reclaimed before Message persistence", async () => {
    const business = await createBusiness();
    const input = webhookClaimInput(business._id, "SM_CRASH_BEFORE_MESSAGE");

    const first = await claimTwilioWebhookEvent(input);
    expect(
      await Message.countDocuments({
        business: business._id,
        providerMessageId: "SM_CRASH_BEFORE_MESSAGE",
      }),
    ).toBe(0);

    await WebhookEvent.updateOne(
      { _id: first.event._id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1) } },
    );

    const reclaimed = await claimTwilioWebhookEvent(input);
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.reclaimed).toBe(true);
  });

  test("3. crash after Message persistence is repaired by ingress reconciliation", async () => {
    const business = await createBusiness();
    const inbound = await makeInboundMessage({
      businessId: business._id,
      providerMessageId: "SM_PERSISTED_NOT_ENQUEUED",
    });

    const result = await reconcileOrphanedInboundSmsJobs();
    expect(result.repaired).toBe(1);

    const job = await SmsProcessingJob.findOne({
      inboundMessage: inbound._id,
    });
    expect(job).toBeTruthy();

    const repaired = await Message.findById(inbound._id);
    expect(repaired.metadata.processingReconciled).toBe(true);
    expect(repaired.metadata.processingEnqueuedAt).toBeTruthy();
  });

  test("4. primary and fallback delivery of the same MessageSid persists once", async () => {
    const business = await createBusiness();

    const payload = {
      From: "4045559999",
      To: "4045551234",
      Body: "STOP",
      MessageSid: "SM_PRIMARY_FALLBACK_RACE",
      OptOutType: "STOP",
    };

    const [primary, fallback] = await Promise.all([
      request(app).post("/api/twilio/sms").type("form").send(payload),
      request(app).post("/api/twilio/sms-fallback").type("form").send(payload),
    ]);

    expect([200, 503]).toContain(primary.status);
    expect([200, 503]).toContain(fallback.status);

    expect(
      await Message.countDocuments({
        business: business._id,
        providerMessageId: "SM_PRIMARY_FALLBACK_RACE",
      }),
    ).toBe(1);
  }, 15000);

  test("5. exhausting primary limiter does not consume fallback capacity", async () => {
    const primary = createCommunicationRouteRateLimit({
      name: "cert-primary",
      max: 1,
      windowMs: 60_000,
      twiml: true,
      keyBuilder: () => ["same-customer"],
    });
    const fallback = createCommunicationRouteRateLimit({
      name: "cert-fallback",
      max: 2,
      windowMs: 60_000,
      twiml: true,
      keyBuilder: () => ["same-customer"],
    });

    const primaryReq = {
      ip: "127.0.0.1",
      path: "/sms",
      body: {},
    };
    const fallbackReq = {
      ip: "127.0.0.1",
      path: "/sms-fallback",
      body: {},
    };

    expect((await runMiddleware(primary, primaryReq)).next).toBe(true);
    expect((await runMiddleware(primary, primaryReq)).statusCode).toBe(429);
    expect((await runMiddleware(fallback, fallbackReq)).next).toBe(true);

    // Also prove production exports are distinct middleware functions.
    expect(twilioSmsFallbackWebhookRateLimit).not.toBe(
      twilioSmsWebhookRateLimit,
    );
  });

  test("6. uncertain Twilio acceptance never auto-resends deterministic reply", async () => {
    const business = await createBusiness();
    const conversationId = new mongoose.Types.ObjectId();
    const leadId = new mongoose.Types.ObjectId();
    const inbound = await makeInboundMessage({
      businessId: business._id,
      providerMessageId: "SM_UNCERTAIN_INBOUND",
      processingRequired: false,
    });

    const conversation = {
      _id: conversationId,
      lead: leadId,
      customerPhone: "4045559999",
      replyFromPhone: "4045551234",
    };
    const lead = { _id: leadId };

    const uncertain = Object.assign(new Error("provider timeout"), {
      code: "ETIMEDOUT",
    });
    mockTwilioMessageCreate.mockRejectedValueOnce(uncertain);

    const first = await sendIdempotentInboundSmsReply({
      business,
      conversation,
      lead,
      inboundMessage: inbound,
      body: "We received your request.",
      metadata: { source: "sms_10of10_cert" },
    });

    expect(first.deliveryUncertain).toBe(true);

    const second = await sendIdempotentInboundSmsReply({
      business,
      conversation,
      lead,
      inboundMessage: inbound,
      body: "We received your request.",
      metadata: { source: "sms_10of10_cert" },
    });

    expect(second.deliveryUncertain).toBe(true);
    expect(mockTwilioMessageCreate).toHaveBeenCalledTimes(1);
  });

  test("7. STOP/START/HELP variants classify consistently", async () => {
    expect(
      classifyInboundSmsCommand("STOP", { twilioOptOutType: "STOP" }),
    ).toMatchObject({ action: "opt_out", providerManaged: true });

    expect(classifyInboundSmsCommand("stop")).toMatchObject({
      action: "opt_out",
      providerManaged: true,
    });
    expect(classifyInboundSmsCommand("STOP.")).toMatchObject({
      action: "opt_out",
      providerManaged: false,
      softOptOut: true,
    });
    expect(classifyInboundSmsCommand("please stop texting me")).toMatchObject({
      action: "opt_out",
      providerManaged: false,
      softOptOut: true,
    });
    expect(classifyInboundSmsCommand("START")).toMatchObject({
      action: "opt_in",
    });
    expect(classifyInboundSmsCommand("UNSTOP")).toMatchObject({
      action: "opt_in",
    });
    expect(classifyInboundSmsCommand("HELP")).toMatchObject({
      action: "help",
    });
  });

  test("8. Advanced Opt-Out present and absent both preserve local consent truth", async () => {
    const business = await createBusiness();

    const providerManaged = await processInboundSmsCommand({
      businessId: business._id,
      phone: "4045559999",
      messageBody: "STOP",
      twilioOptOutType: "STOP",
      suppressProviderManagedReply: true,
    });
    expect(providerManaged.reply).toBe("");
    expect(
      (await getSmsPreference({
        businessId: business._id,
        phone: "4045559999",
      })).smsStatus,
    ).toBe("opted_out");

    await clearTestDB();
    const business2 = await createBusiness();

    const appManaged = await processInboundSmsCommand({
      businessId: business2._id,
      phone: "4045559999",
      messageBody: "please stop texting me",
      twilioOptOutType: "",
      suppressProviderManagedReply: true,
    });
    expect(appManaged.reply).toBeTruthy();
    expect(
      (await getSmsPreference({
        businessId: business2._id,
        phone: "4045559999",
      })).smsStatus,
    ).toBe("opted_out");
  });

  test("9. malformed orphan is durably marked and emits an operational alert", async () => {
    const business = await createBusiness();
    const inbound = await makeInboundMessage({
      businessId: business._id,
      providerMessageId: "SM_MISSING_LEAD",
      withLead: false,
    });

    await reconcileOrphanedInboundSmsJobs();

    const raw = await Message.collection.findOne({ _id: inbound._id });
    expect(raw.metadata.processingRequired).toBe(false);
    expect(raw.metadata.processingReconciliationState).toBe(
      "invalid_context",
    );
    expect(raw.metadata.processingReconciliationError).toContain(
      "missing_lead",
    );

    const alert = await Alert.findOne({
      business: business._id,
      "metadata.inboundMessageId": String(inbound._id),
    });
    expect(alert).toBeTruthy();
  });

  test("10. delivery callback arriving before Message persistence is reconciled later", async () => {
    const business = await createBusiness();
    const providerMessageId = "SM_STATUS_BEFORE_MESSAGE";

    const first = await processTwilioMessageStatus({
      businessId: business._id,
      payload: {
        MessageSid: providerMessageId,
        MessageStatus: "delivered",
      },
    });

    expect(first.message).toBeNull();
    expect(first.reconciliationPending).toBe(true);

    const conversationId = new mongoose.Types.ObjectId();
    await Message.create({
      business: business._id,
      conversation: conversationId,
      lead: new mongoose.Types.ObjectId(),
      direction: "outbound",
      from: "4045551234",
      to: "4045559999",
      body: "Your appointment is confirmed.",
      provider: "twilio",
      providerMessageId,
      status: "sent",
      deliveryStatus: "sent",
    });

    await SmsDeliveryReconciliationEvent.updateMany(
      { business: business._id, providerMessageId },
      { $set: { availableAt: new Date(Date.now() - 1) } },
    );

    const drained = await drainSmsDeliveryReconciliationOnce();
    expect(drained.applied).toBeGreaterThanOrEqual(1);

    const message = await Message.findOne({
      business: business._id,
      providerMessageId,
    });
    expect(message.status).toBe("delivered");

    const event = await SmsDeliveryReconciliationEvent.findOne({
      business: business._id,
      providerMessageId,
    });
    expect(event.status).toBe("applied");
  });

  test("11. a soft opt-out committed before provider send wins the race", async () => {
    const business = await createBusiness();

    setBeforeSmsProviderSendHookForTests(async () => {
      await optOutSms({
        businessId: business._id,
        phone: "4045559999",
        source: "customer_request",
        keyword: "please stop texting me",
      });
    });

    const result = await sendSms({
      business,
      businessId: business._id,
      to: "4045559999",
      body: "Following up on your service request.",
      actorType: "system",
      source: "sms_10of10_cert",
      usageCategory: "sms",
      bypassUsageLimits: true,
      directResponse: true,
    });

    expect(result.suppressed).toBe(true);
    expect(result.reason).toBe("customer_opted_out");
    expect(mockTwilioMessageCreate).not.toHaveBeenCalled();

    const preference = await ContactPreference.findOne({
      business: business._id,
      phone: "+14045559999",
    });
    expect(preference.smsStatus).toBe("opted_out");
  });
});
