import Business from "../../src/models/business.js";
import VoiceWebhookController from "../../src/controllers/voiceWebhook.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";

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

  test("dials the dedicated live-transfer phone, not the initial staff-routing phone", async () => {
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

    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("+14045550188"),
    );
    expect(res.send).not.toHaveBeenCalledWith(
      expect.stringContaining(">+14045550109</Number>"),
    );
  });

  test("uses SMS and alert fallback when the dedicated line is unavailable", async () => {
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
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("could not be reached by phone"),
    );
  });
});
