import Business from "../../src/models/business.js";
import TwilioController from "../../src/controllers/twilio.js";
import VoiceWebhookController from "../../src/controllers/voiceWebhook.js";
import VoiceAvailabilityService from "../../src/voice/voiceAvailability.service.js";
import VoiceSessionService from "../../src/voice/voiceSession.service.js";
import VoiceFailureService from "../../src/voice/voiceFailure.service.js";

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

jest.mock("../../src/voice/voiceFailure.service.js", () => ({
  __esModule: true,
  default: { record: jest.fn() },
}));

const response = () => {
  const res = { type: jest.fn(), status: jest.fn(), send: jest.fn() };
  res.type.mockReturnValue(res);
  res.status.mockReturnValue(res);
  return res;
};

const request = (body = {}, query = {}) => ({
  body: {
    From: "+14045550100",
    To: "+14045550101",
    CallSid: "CA123",
    ...body,
  },
  query,
});

const makeBusiness = (routingPolicy, overrides = {}) => ({
  _id: "business-1",
  businessName: "Peachtree Plumbing",
  phone: "+14045550101",
  forwardingPhone: "+14045550109",
  features: { voiceAiEnabled: true, aiBookingEnabled: true },
  voiceSettings: {
    answerMode: "custom",
    routingPolicyVersion: 1,
    routingPolicy,
    overflowRingSeconds: 20,
    transferPhone: "+14045550109",
    welcomeGreeting: "Thanks for calling.",
    recordingEnabled: false,
  },
  ...overrides,
});

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe("VoiceWebhookController business-selected AI/SMS routing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VOICE_HTTP_PUBLIC_URL: "https://api.callbackiq.com",
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
      TWILIO_AUTH_TOKEN: "token",
      PHASE9_ENABLE_LIVE_TEST_HOOKS: "false",
      PHASE9_FORCE_RELAY_FAILURE: "false",
    };
    VoiceSessionService.ensureContext.mockResolvedValue({
      _id: "voice-session-1",
      status: "routing",
      save: jest.fn().mockResolvedValue(undefined),
    });
    VoiceSessionService.sendFallbackSms.mockResolvedValue(undefined);
    VoiceFailureService.record.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("uses AI voice after hours and SMS during open hours when selected", async () => {
    Business.findOne.mockResolvedValue(
      makeBusiness({
        openHours: "sms",
        afterHours: "voice_ai",
        voiceFailure: "sms",
      }),
    );

    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(false);
    const afterHours = response();
    await VoiceWebhookController.initial(request(), afterHours);
    expect(afterHours.send).toHaveBeenCalledWith(
      expect.stringContaining("<ConversationRelay"),
    );

    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(true);
    const openHours = response();
    await VoiceWebhookController.initial(request(), openHours);
    expect(openHours.send).toHaveBeenCalledWith(expect.stringContaining("<Say>"));
    expect(openHours.send).not.toHaveBeenCalledWith(
      expect.stringContaining("<ConversationRelay"),
    );
    await flushPromises();
    expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "voice-session-1" }),
    );
  });

  test("rings staff and preserves AI as the signed no-answer fallback", async () => {
    Business.findOne.mockResolvedValue(
      makeBusiness({
        openHours: "staff_then_voice_ai",
        afterHours: "staff_then_sms",
        voiceFailure: "sms",
      }),
    );
    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(true);
    const res = response();

    await VoiceWebhookController.initial(request(), res);

    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain("<Dial");
    expect(twiml).toContain("fallback=voice_ai");
    expect(twiml).toContain("scenario=open_hours");
  });

  test("uses the callback fallback selected by the original scenario", async () => {
    Business.findOne.mockResolvedValue(
      makeBusiness({
        openHours: "staff_then_voice_ai",
        afterHours: "staff_then_sms",
        voiceFailure: "sms",
      }),
    );
    const res = response();

    await VoiceWebhookController.overflow(
      request({ DialCallStatus: "no-answer" }, { fallback: "voice_ai" }),
      res,
    );

    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("<ConversationRelay"),
    );
  });

  test("tries staff after a voice failure when the business selected staff-then-SMS", async () => {
    Business.findOne.mockResolvedValue(
      makeBusiness({
        openHours: "voice_ai",
        afterHours: "voice_ai",
        voiceFailure: "staff_then_sms",
      }),
    );
    const res = response();

    await VoiceWebhookController.complete(
      request({
        HandoffData: JSON.stringify({
          reasonCode: "voice-failure",
          reason: "model unavailable",
        }),
      }),
      res,
    );

    const twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain("<Dial");
    expect(twiml).toContain("voice-transfer-complete");
    expect(VoiceSessionService.sendFallbackSms).not.toHaveBeenCalled();
    await flushPromises();
    expect(VoiceFailureService.record).toHaveBeenCalledWith({
      sessionId: "voice-session-1",
      failureReason: "model unavailable",
    });
  });

  test("always returns terminating TwiML even when the asynchronous SMS fallback rejects", async () => {
    Business.findOne.mockResolvedValue(
      makeBusiness({
        openHours: "sms",
        afterHours: "sms",
        voiceFailure: "sms",
      }),
    );
    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(true);
    VoiceSessionService.sendFallbackSms.mockRejectedValue(
      new Error("database unavailable"),
    );
    const res = response();

    await VoiceWebhookController.initial(request(), res);

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<Hangup/>"));
    await flushPromises();
  });

  test("preserves the original Twilio flow when Phase 9 is disabled", async () => {
    const business = makeBusiness(
      { openHours: "sms", afterHours: "sms", voiceFailure: "sms" },
      { features: { voiceAiEnabled: false, aiBookingEnabled: true } },
    );
    Business.findOne.mockResolvedValue(business);
    const req = request();
    const res = response();

    await VoiceWebhookController.initial(req, res);

    expect(TwilioController.voiceWebhook).toHaveBeenCalledWith(req, res);
  });
});
