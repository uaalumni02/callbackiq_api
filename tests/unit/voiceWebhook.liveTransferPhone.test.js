import Business from "../../src/models/business.js";
import VoiceWebhookController from "../../src/controllers/voiceWebhook.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";
import { resolveTwilioNumberContext } from "../../src/services/twilioBusinessResolver.service.js";

jest.mock("../../src/services/twilioBusinessResolver.service.js", () => ({
  __esModule: true,
  resolveTwilioNumberContext: jest.fn(),
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/controllers/twilio.js", () => ({
  __esModule: true,
  default: { voiceWebhook: jest.fn() },
}));

jest.mock("../../src/voice/voiceAvailability.service.js", () => ({
  __esModule: true,
  default: { isBusinessOpen: jest.fn() },
}));

jest.mock("../../src/voice/voiceSession.service.js", () => ({
  __esModule: true,
  default: {
    ensureContext: jest.fn(),
    sendFallbackSms: jest.fn(),
    markCompleted: jest.fn(),
  },
}));

const response = () => {
  const res = {
    type: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
  };
  res.type.mockReturnValue(res);
  res.status.mockReturnValue(res);
  return res;
};

const request = (handoffData) => ({
  body: {
    From: "+14045550100",
    To: "+14045550101",
    CallSid: "CA123",
    HandoffData: JSON.stringify(handoffData),
  },
});

describe("VoiceWebhookController dedicated live-transfer destination", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveTwilioNumberContext.mockImplementation(async () => ({
      business: await Business.findOne(),
      trackingNumber: null,
      marketingSource: null,
      attribution: {},
    }));
    process.env = {
      ...originalEnv,
      VOICE_HTTP_PUBLIC_URL: "https://api.callbackiq.com",
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
      TWILIO_AUTH_TOKEN: "token",
    };
    VoiceSessionService.ensureContext.mockResolvedValue({
      _id: "voice-session-1",
      save: jest.fn(),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("never dials either staff number from a legacy post-AI handoff", async () => {
    Business.findOne.mockResolvedValue({
      _id: "business-1",
      businessName: "Peachtree Plumbing",
      phone: "+14045550101",
      forwardingPhone: "+14045550109",
      features: { voiceAiEnabled: true },
      voiceSettings: {
        answerMode: "always",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "voice_ai",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
        overflowRingSeconds: 20,
        transferPhone: "+14045550109",
        liveTransferEnabled: true,
        liveTransferPhone: "+14045550188",
      },
    });
    const res = response();

    await VoiceWebhookController.complete(
      request({
        reasonCode: "live-agent-handoff",
        reason: "customer_requested_human",
      }),
      res,
    );

    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain("<Say>");
    expect(twiml).toContain("cannot connect a live staff member");
    expect(twiml).not.toMatch(/<Dial\b|<Number\b/);
    expect(twiml).not.toContain("+14045550188");
    expect(twiml).not.toContain("+14045550109");
    // Fallback is queued for review without bridging a new telephone call.
    await Promise.resolve();
    expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "voice-session-1" }),
    );
  });

  test("keeps the same no-dial fallback when legacy live transfer is disabled", async () => {
    Business.findOne.mockResolvedValue({
      _id: "business-1",
      businessName: "Peachtree Plumbing",
      phone: "+14045550101",
      features: { voiceAiEnabled: true },
      voiceSettings: {
        answerMode: "always",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "voice_ai",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
        overflowRingSeconds: 20,
        transferPhone: "+14045550109",
        liveTransferEnabled: false,
        liveTransferPhone: "",
      },
    });
    const res = response();

    await VoiceWebhookController.complete(
      request({
        reasonCode: "live-agent-handoff",
        reason: "customer_requested_human",
      }),
      res,
    );

    expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "voice-session-1" }),
    );
    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain("Your inquiry has been saved for review");
    expect(twiml).toContain("cannot connect a live staff member");
    expect(twiml).not.toMatch(/<Dial\b|<Number\b/);
    expect(twiml).not.toContain("+14045550109");
  });
});
