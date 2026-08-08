import request from "supertest";
import mongoose from "mongoose";
import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import WebhookEvent from "../../src/models/webhookEvent.js";
import { sendSms } from "../../src/services/twilioSmsService.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

jest.mock("../../src/services/twilioSmsService.js", () => ({
  sendSms: jest.fn(),
}));

beforeAll(async () => {
  await connectTestDB();
  await WebhookEvent.init();
});

beforeEach(() => {
  sendSms.mockRejectedValue(
    Object.assign(new Error("Attempt to send to unsubscribed recipient"), {
      code: 21610,
      status: 400,
    }),
  );
});

afterEach(async () => {
  jest.clearAllMocks();
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

describe("POST /api/twilio/voice SMS failure isolation", () => {
  test("returns spoken TwiML and records the missed call when SMS rejects", async () => {
    const business = await Business.create({
      owner: new mongoose.Types.ObjectId(),
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "+14045551234",
      trackingNumber: { provider: "twilio", status: "active" },
      email: "owner@atlantaproplumbing.com",
      estimatedJobValue: 800,
      features: {
        missedCallSmsEnabled: true,
        voiceAiEnabled: false,
      },
      voiceSettings: {
        answerMode: "disabled",
        routingPolicy: {
          openHours: "sms",
          afterHours: "sms",
          voiceFailure: "sms",
        },
      },
    });

    const response = await request(app)
      .post("/api/twilio/voice")
      .type("form")
      .send({
        From: "+14045559999",
        To: "+14045551234",
        CallSid: "CA_SMS_FAILURE_21610",
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/xml");
    expect(response.text).toContain("<Say>");
    expect(response.text).toMatch(/team has been notified/i);
    expect(response.text).not.toContain("<Response></Response>");

    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        to: "+14045559999",
        source: "missed_call_recovery",
      }),
    );

    const callLog = await CallLog.findOne({
      business: business._id,
      providerCallId: "CA_SMS_FAILURE_21610",
    });
    expect(callLog).toBeTruthy();
    expect(callLog.missedCallTextSent).toBe(false);

    expect(
      await Lead.countDocuments({
        business: business._id,
        phone: "+14045559999",
      }),
    ).toBe(1);
    expect(
      await Conversation.countDocuments({
        business: business._id,
        customerPhone: "+14045559999",
      }),
    ).toBe(1);
  });
});
