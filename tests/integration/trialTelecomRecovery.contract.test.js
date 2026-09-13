jest.setTimeout(30000);

import request from "supertest";
import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import TrialRedemption from "../../src/models/trialRedemption.js";
import Message from "../../src/models/message.js";
import A2pCustomerRegistration from "../../src/models/a2pCustomerRegistration.js";
import fs from "node:fs";
import path from "node:path";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import { handleSmsRecoveryVoiceWebhook } from "../../src/services/twilioSmsWebhook.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

const mockAvailableList = jest.fn();
const mockIncomingCreate = jest.fn();
const mockIncomingFetch = jest.fn();
const mockIncomingUpdate = jest.fn();
const mockIncomingRemove = jest.fn();
const mockSenderList = jest.fn();
const mockSenderCreate = jest.fn();
const mockCampaignList = jest.fn();
const mockMessagesCreate = jest.fn();

const mockIncomingPhoneNumbers = Object.assign(
  jest.fn(() => ({
    fetch: mockIncomingFetch,
    update: mockIncomingUpdate,
    remove: mockIncomingRemove,
  })),
  { create: mockIncomingCreate },
);

const mockMessagingService = {
  phoneNumbers: {
    list: mockSenderList,
    create: mockSenderCreate,
  },
  usAppToPerson: {
    list: mockCampaignList,
  },
};

const mockTwilioClient = {
  availablePhoneNumbers: jest.fn(() => ({
    local: { list: mockAvailableList },
  })),
  incomingPhoneNumbers: mockIncomingPhoneNumbers,
  messaging: {
    v1: {
      services: jest.fn(() => mockMessagingService),
    },
  },
  messages: {
    create: mockMessagesCreate,
  },
};

jest.mock("twilio", () => {
  const actual = jest.requireActual("twilio");
  const actualDefault = actual.default || actual;
  const factory = jest.fn(() => mockTwilioClient);
  Object.assign(factory, actualDefault);
  return {
    ...actual,
    __esModule: true,
    default: factory,
  };
});

jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  __esModule: true,
  getPriceIdByPlan: jest.fn(() => "price_pro_test"),
  getStripeClient: jest.fn(),
}));

jest.mock("../../src/helpers/email/mailer.js", () => ({
  sendTrialWelcomeEmail: jest.fn(async () => true),
  sendTrialReminderEmail: jest.fn(async () => true),
  sendTrialExpiredEmail: jest.fn(async () => true),
  sendTrackingNumberReleasedEmail: jest.fn(async () => true),
}));

const responseHarness = () => {
  const state = { statusCode: 200, body: "", type: "", headers: {} };
  const res = {
    type: jest.fn((value) => {
      state.type = value;
      return res;
    }),
    status: jest.fn((value) => {
      state.statusCode = value;
      return res;
    }),
    send: jest.fn((value) => {
      state.body = value;
      return res;
    }),
    set: jest.fn((name, value) => {
      state.headers[name] = value;
      return res;
    }),
  };
  return { res, state };
};

describe("trial -> Stripe -> tracking number -> A2P -> missed-call SMS contract", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.TWILIO_ACCOUNT_SID = "AC11111111111111111111111111111111";
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.example.test";
    process.env.A2P_EVENT_STREAM_USERNAME = "ci-a2p-user";
    process.env.A2P_EVENT_STREAM_PASSWORD = "ci-a2p-pass";
    await connectTestDB();
    await TrialRedemption.init();
  }, 60_000);

  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailableList.mockResolvedValue([
      { phoneNumber: "+16785550123" },
    ]);
    mockIncomingCreate.mockResolvedValue({
      sid: "PN11111111111111111111111111111111",
      phoneNumber: "+16785550123",
    });
    mockIncomingFetch.mockResolvedValue({
      sid: "PN11111111111111111111111111111111",
      phoneNumber: "+16785550123",
      voiceUrl: "https://api.example.test/api/twilio/voice",
      smsUrl: "https://api.example.test/api/twilio/sms",
      statusCallback: "https://api.example.test/api/twilio/status",
    });
    mockIncomingUpdate.mockResolvedValue({});
    mockIncomingRemove.mockResolvedValue(true);
    mockSenderList.mockResolvedValue([]);
    mockSenderCreate.mockResolvedValue({
      sid: "PN11111111111111111111111111111111",
      phoneNumberSid: "PN11111111111111111111111111111111",
    });
    mockCampaignList.mockResolvedValue([
      {
        sid: "QE11111111111111111111111111111111",
        campaignStatus: "VERIFIED",
        usAppToPersonUsecase: "LOW_VOLUME_STANDARD",
      },
    ]);
    mockMessagesCreate.mockResolvedValue({
      sid: "SM11111111111111111111111111111111",
      status: "queued",
      to: "+14045550100",
      from: "+16785550123",
    });
  });

  afterEach(clearTestDB);
  afterAll(closeTestDB);

  test("a signed trial activation provisions the sender and a missed call produces a recovery SMS", async () => {
    const registration = await request(app)
      .post("/api/auth/register")
      .send({
        userName: "telecomcontract",
        email: "telecom.contract@example.com",
        password: "Password123",
        businessName: "Contract Plumbing",
        businessPhone: "4045551212",
        businessType: "plumbing",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      });

    expect(registration.status).toBe(201);
    const { business, user } = registration.body.data;

    await Business.findByIdAndUpdate(business._id, {
      $set: {
        "messagingCompliance.messagingServiceSid":
          "MG11111111111111111111111111111111",
      },
    });

    await A2pCustomerRegistration.create({
      business: business._id,
      registrationType: "low_volume_standard",
      status: "number_pending",
      campaignStatus: "VERIFIED",
      numberStatus: "PENDING_REGISTRATION",
      messagingServiceSid: "MG11111111111111111111111111111111",
      campaignSid: "CM11111111111111111111111111111111",
    });

    const now = Math.floor(Date.now() / 1000);
    const remote = {
      id: "sub_trial_telecom_contract",
      customer: "cus_trial_telecom_contract",
      status: "trialing",
      trial_start: now,
      trial_end: now + 14 * 86400,
      current_period_start: now,
      current_period_end: now + 14 * 86400,
      cancel_at_period_end: false,
      metadata: {
        businessId: String(business._id),
        ownerId: String(user._id),
        plan: "pro",
      },
      items: { data: [{ price: { id: "price_pro_test" } }] },
      latest_invoice: null,
    };

    getStripeClient.mockReturnValue({
      webhooks: {
        constructEvent: jest.fn((body) => JSON.parse(body.toString("utf8"))),
      },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(remote),
        cancel: jest.fn().mockResolvedValue({ ...remote, status: "canceled" }),
      },
    });

    const activation = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "sig_test")
      .set("Content-Type", "application/json")
      .send({
        id: "evt_trial_telecom_contract",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_trial_telecom_contract",
            customer: remote.customer,
            subscription: remote.id,
            metadata: remote.metadata,
          },
        },
      });

    expect(activation.status).toBe(200);

    const storedSubscription = await Subscription.findOne({
      business: business._id,
    });
    expect(storedSubscription.status).toBe("trialing");
    expect(storedSubscription.isActive).toBe(true);

    let activatedBusiness = await Business.findById(business._id).select(
      "+trackingNumber.providerSid +messagingCompliance.messagingServiceSid",
    );
    expect(activatedBusiness.phone).toBe("+16785550123");
    expect(activatedBusiness.trackingNumber.status).toBe("active");
    expect(activatedBusiness.messagingCompliance.senderAttached).toBe(true);
    expect(activatedBusiness.messagingCompliance.campaignStatus).toBe("VERIFIED");
    expect(activatedBusiness.messagingCompliance.smsReady).toBe(false);
    expect(mockSenderCreate).toHaveBeenCalledWith({
      phoneNumberSid: "PN11111111111111111111111111111111",
    });

    /*
     * Sender-pool membership is intentionally not treated as carrier readiness.
     * Exercise the real CallBackIQ A2P Event Streams endpoint with a sanitized
     * Twilio-shaped number-registration.successful fixture before SMS recovery.
     */
    const a2pFixture = JSON.parse(
      fs.readFileSync(
        path.resolve(
          process.cwd(),
          "tests/fixtures/providers/a2p/number-registration-succeeded.json",
        ),
        "utf8",
      ),
    );

    const a2pEvent = await request(app)
      .post("/api/a2p-events/twilio")
      .auth(
        process.env.A2P_EVENT_STREAM_USERNAME,
        process.env.A2P_EVENT_STREAM_PASSWORD,
      )
      .send(a2pFixture);

    expect(a2pEvent.status).toBe(204);

    activatedBusiness = await Business.findById(business._id);
    expect(activatedBusiness.messagingCompliance.a2pStatus).toBe("registered");
    expect(activatedBusiness.messagingCompliance.campaignStatus).toBe("VERIFIED");
    expect(activatedBusiness.messagingCompliance.senderAttached).toBe(true);
    expect(activatedBusiness.messagingCompliance.smsReady).toBe(true);

    const a2pRegistration = await A2pCustomerRegistration.findOne({
      business: business._id,
    });
    expect(a2pRegistration.status).toBe("ready");
    expect(a2pRegistration.numberStatus).toBe("REGISTERED");

    const { res, state } = responseHarness();
    await handleSmsRecoveryVoiceWebhook(
      {
        body: {
          From: "+14045550100",
          To: "+16785550123",
          CallSid: "CA11111111111111111111111111111111",
          CallStatus: "no-answer",
        },
      },
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const providerSend = mockMessagesCreate.mock.calls[0][0];
    expect(providerSend).toEqual(
      expect.objectContaining({
        to: "+14045550100",
        body: expect.any(String),
      }),
    );
    expect(
      providerSend.from === "+16785550123" ||
        providerSend.messagingServiceSid ===
          "MG11111111111111111111111111111111",
    ).toBe(true);
    expect(
      await Message.countDocuments({
        business: business._id,
        direction: "outbound",
        usageCategory: "missed_call_recovery",
      }),
    ).toBe(1);
  });
});
