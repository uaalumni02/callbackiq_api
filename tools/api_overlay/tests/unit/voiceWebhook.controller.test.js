import Business from "../../src/models/business.js";
import TwilioController from "../../src/controllers/twilio.js";
import VoiceWebhookController from "../../src/controllers/voiceWebhook.js";
import VoiceAvailabilityService from "../../src/voice/voiceAvailability.service.js";
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

const request = (body = {}) => ({
  body: {
    From: "+14045550100",
    To: "+14045550101",
    CallSid: "CA123",
    ...body,
  },
});

const makeBusiness = (overrides = {}) => ({
  _id: "business-1",
  businessName: "Peachtree Plumbing",
  phone: "+14045550101",
  forwardingPhone: "+14045550109",
  features: { voiceAiEnabled: true, aiBookingEnabled: true },
  voiceSettings: {
    answerMode: "after_hours",
    overflowRingSeconds: 20,
    transferPhone: "+14045550109",
    welcomeGreeting: "Thanks for calling.",
  },
  ...overrides,
});

describe("VoiceWebhookController", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VOICE_HTTP_PUBLIC_URL: "https://api.callbackiq.com",
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
      TWILIO_AUTH_TOKEN: "token",
    };
    Business.findOne.mockResolvedValue(makeBusiness());
    VoiceSessionService.ensureContext.mockResolvedValue({
      _id: "voice-session-1",
      status: "routing",
      save: jest.fn(),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("speaks an apology instead of silence when required call fields are missing", async () => {
    const res = response();

    await VoiceWebhookController.initial(
      request({ CallSid: "" }),
      res,
    );

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<Say>"));
    expect(res.send).not.toHaveBeenCalledWith(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    expect(VoiceSessionService.ensureContext).not.toHaveBeenCalled();
  });

  test("speaks an apology instead of silence when no business owns the number", async () => {
    Business.findOne.mockResolvedValue(null);
    const res = response();

    await VoiceWebhookController.initial(request(), res);

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<Say>"));
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("not configured for voice assistance"),
    );
    expect(VoiceSessionService.ensureContext).not.toHaveBeenCalled();
  });

  test("preserves the existing Twilio voice flow when voice AI is disabled", async () => {
    const business = makeBusiness({
      features: { voiceAiEnabled: false, aiBookingEnabled: true },
    });
    Business.findOne.mockResolvedValue(business);
    const req = request();
    const res = response();

    await VoiceWebhookController.initial(req, res);

    expect(TwilioController.voiceWebhook).toHaveBeenCalledWith(req, res);
    expect(VoiceSessionService.ensureContext).not.toHaveBeenCalled();
  });

  test("answers with ConversationRelay after hours", async () => {
    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(false);
    const res = response();

    await VoiceWebhookController.initial(request(), res);

    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("<ConversationRelay"),
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("wss://api.callbackiq.com/ws/voice"),
    );
  });

  test("rings staff first in overflow mode", async () => {
    Business.findOne.mockResolvedValue(
      makeBusiness({
        voiceSettings: {
          answerMode: "overflow",
          overflowRingSeconds: 18,
          transferPhone: "+14045550109",
        },
      }),
    );
    const res = response();

    await VoiceWebhookController.initial(request(), res);

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<Dial"));
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("+14045550109"),
    );
  });

  test("uses missed-call SMS instead of voice AI when after-hours mode overflows while open", async () => {
    VoiceAvailabilityService.isBusinessOpen.mockResolvedValue(true);
    const res = response();

    await VoiceWebhookController.overflow(
      request({ DialCallStatus: "no-answer" }),
      res,
    );

    expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "voice-session-1" }),
    );
    expect(res.send).not.toHaveBeenCalledWith(
      expect.stringContaining("<ConversationRelay"),
    );
  });

  test("apologizes and triggers fallback instead of returning silence on routing errors", async () => {
    VoiceAvailabilityService.isBusinessOpen.mockRejectedValue(
      new Error("availability unavailable"),
    );
    const res = response();

    await VoiceWebhookController.initial(request(), res);

    expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "voice-session-1" }),
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<Say>"));
    expect(res.send).not.toHaveBeenCalledWith(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  test("preserves failure fallback from ConversationRelay handoff data", async () => {
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

    expect(VoiceSessionService.sendFallbackSms).toHaveBeenCalledWith({
      sessionId: "voice-session-1",
      failureReason: "model unavailable",
    });
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("voice assistant could not continue"),
    );
  });
});
