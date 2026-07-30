import VoiceSettingsController from "../../src/controllers/voiceSettings.js";
import { getOwnedBusiness } from "../../src/services/businessScope.service.js";

jest.mock("../../src/services/businessScope.service.js", () => ({
  __esModule: true,
  getOwnedBusiness: jest.fn(),
}));

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};

const makeBusiness = (overrides = {}) => {
  const business = {
    features: { voiceAiEnabled: true, aiBookingEnabled: true },
    voiceSettings: {
      answerMode: "overflow",
      routingPolicyVersion: 0,
      overflowRingSeconds: 20,
      transferPhone: "+14045550100",
      welcomeGreeting: "Thanks for calling.",
      recordingEnabled: true,
    },
    forwardingPhone: "",
    set: jest.fn((path, value) => {
      if (path === "features.voiceAiEnabled") {
        business.features.voiceAiEnabled = value;
      }
      if (path === "voiceSettings") business.voiceSettings = value;
    }),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return business;
};

describe("VoiceSettingsController configurable routing", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VOICE_WEBSOCKET_PUBLIC_URL: "wss://api.callbackiq.com/ws/voice",
      VOICE_HTTP_PUBLIC_URL: "https://api.callbackiq.com",
      TWILIO_AUTH_TOKEN: "test-auth-token",
      PHASE9_ENABLE_LIVE_TEST_HOOKS: "false",
      PHASE9_FORCE_RELAY_FAILURE: "false",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("saves independent open-hours, after-hours, and failure actions", async () => {
    const business = makeBusiness();
    getOwnedBusiness.mockResolvedValue(business);
    const req = {
      user: { userId: "owner" },
      body: {
        voiceAiEnabled: true,
        routingPolicy: {
          openHours: "staff_then_sms",
          afterHours: "voice_ai",
          voiceFailure: "staff_then_sms",
        },
        transferPhone: "+14045550109",
      },
    };
    const res = response();
    const next = jest.fn();

    await VoiceSettingsController.update(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(business.voiceSettings).toEqual(
      expect.objectContaining({
        answerMode: "custom",
        routingPolicyVersion: 1,
        routingPolicy: req.body.routingPolicy,
        transferPhone: "+14045550109",
        recordingEnabled: false,
      }),
    );
    expect(business.save).toHaveBeenCalled();
  });

  test("maps legacy presets to an explicit versioned routing policy", async () => {
    const business = makeBusiness();
    getOwnedBusiness.mockResolvedValue(business);
    const res = response();

    await VoiceSettingsController.update(
      {
        user: { userId: "owner" },
        body: { answerMode: "after_hours" },
      },
      res,
      jest.fn(),
    );

    expect(business.voiceSettings.routingPolicy).toEqual({
      openHours: "staff_then_sms",
      afterHours: "voice_ai",
      voiceFailure: "sms",
    });
    expect(business.voiceSettings.answerMode).toBe("after_hours");
  });

  test("rejects attempts to enable inert call recording", async () => {
    getOwnedBusiness.mockResolvedValue(makeBusiness());
    const next = jest.fn();

    await VoiceSettingsController.update(
      {
        user: { userId: "owner" },
        body: { recordingEnabled: true },
      },
      response(),
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        code: "VOICE_RECORDING_NOT_AVAILABLE",
      }),
    );
  });

  test("does not require WSS or AI booking for an SMS-only routing policy", async () => {
    delete process.env.VOICE_WEBSOCKET_PUBLIC_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
    const business = makeBusiness({
      features: { voiceAiEnabled: true, aiBookingEnabled: false },
      voiceSettings: {
        answerMode: "custom",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "sms",
          afterHours: "sms",
          voiceFailure: "sms",
        },
        transferPhone: "",
        recordingEnabled: false,
      },
    });
    getOwnedBusiness.mockResolvedValue(business);
    const res = response();

    await VoiceSettingsController.readiness(
      { user: { userId: "owner" }, query: {} },
      res,
      jest.fn(),
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.ready).toBe(true);
    expect(payload.data.requirements.usesVoiceAi).toBe(false);
    expect(payload.data.checks.conversationRelayConfigured).toBe(true);
  });

  test("requires a transfer phone only when a selected route uses staff", async () => {
    const business = makeBusiness({
      voiceSettings: {
        answerMode: "custom",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "staff_then_voice_ai",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
        transferPhone: "",
        recordingEnabled: false,
      },
    });
    getOwnedBusiness.mockResolvedValue(business);
    const res = response();

    await VoiceSettingsController.readiness(
      { user: { userId: "owner" }, query: {} },
      res,
      jest.fn(),
    );

    expect(res.json.mock.calls[0][0].data.checks.transferPhoneConfigured).toBe(
      false,
    );
  });
});
