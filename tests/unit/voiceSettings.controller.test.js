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
    features: { voiceAiEnabled: true, aiBookingEnabled: false },
    voiceSettings: {
      answerMode: "overflow",
      routingPolicyVersion: 1,
      routingPolicy: {
        openHours: "staff_then_voice_ai",
        afterHours: "voice_ai",
        voiceFailure: "sms",
      },
      liveTransferEnabled: false,
      overflowRingSeconds: 20,
      transferPhone: "+14045550100",
      liveTransferPhone: "",
      welcomeGreeting: "Thanks for calling.",
      recordingEnabled: false,
    },
    forwardingPhone: "",
    set: jest.fn((path, value) => {
      if (path === "features.voiceAiEnabled") {
        business.features.voiceAiEnabled = value;
      }
      if (path === "features.aiBookingEnabled") {
        business.features.aiBookingEnabled = value;
      }
      if (path === "voiceSettings") business.voiceSettings = value;
    }),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return business;
};

describe("VoiceSettingsController callback-first settings", () => {
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

  test("returns separate booking and live-transfer controls", async () => {
    const business = makeBusiness();
    getOwnedBusiness.mockResolvedValue(business);
    const res = response();

    await VoiceSettingsController.get(
      { user: { userId: "owner" }, query: {} },
      res,
      jest.fn(),
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          voiceAiEnabled: true,
          aiBookingEnabled: false,
          liveTransferEnabled: false,
          liveTransferPhone: "",
        }),
      }),
    );
  });

  test("saves automatic booking and optional live transfer independently", async () => {
    const business = makeBusiness();
    getOwnedBusiness.mockResolvedValue(business);
    const res = response();
    const next = jest.fn();

    await VoiceSettingsController.update(
      {
        user: { userId: "owner" },
        body: {
          aiBookingEnabled: true,
          liveTransferEnabled: true,
          transferPhone: "+14045550109",
          liveTransferPhone: "+14045550188",
        },
      },
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(business.set).toHaveBeenCalledWith(
      "features.aiBookingEnabled",
      true,
    );
    expect(business.voiceSettings).toMatchObject({
      liveTransferEnabled: true,
      transferPhone: "+14045550109",
      liveTransferPhone: "+14045550188",
    });
  });

  test("voice answering is ready when booking is off because callback capture is available", async () => {
    const business = makeBusiness({
      features: { voiceAiEnabled: true, aiBookingEnabled: false },
      voiceSettings: {
        answerMode: "always",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "voice_ai",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
        liveTransferEnabled: false,
        transferPhone: "",
        liveTransferPhone: "",
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

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.ready).toBe(true);
    expect(payload.checks.aiBookingEnabled).toBe(false);
    expect(payload.checks.callbackCaptureAvailable).toBe(true);
    expect(payload.capabilities).toEqual(
      expect.objectContaining({
        voiceAnsweringReady: true,
        callbackCaptureEnabled: true,
        automaticBookingEnabled: false,
        liveTransferEnabled: false,
      }),
    );
    expect(payload.recoveryPolicy.bookingUnavailable).toBe(
      "capture_callback",
    );
  });

  test("requires a dedicated phone when optional live transfer is enabled", async () => {
    const business = makeBusiness({
      voiceSettings: {
        answerMode: "always",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "voice_ai",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
        liveTransferEnabled: true,
        transferPhone: "+14045550109",
        liveTransferPhone: "",
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

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.ready).toBe(false);
    expect(payload.checks.liveTransferPhoneConfigured).toBe(false);
    expect(payload.recoveryPolicy.explicitHumanRequest).toBe(
      "capture_callback",
    );
  });

  test("uses live transfer only when enabled with a dedicated phone", async () => {
    const business = makeBusiness({
      voiceSettings: {
        answerMode: "always",
        routingPolicyVersion: 1,
        routingPolicy: {
          openHours: "voice_ai",
          afterHours: "voice_ai",
          voiceFailure: "sms",
        },
        liveTransferEnabled: true,
        transferPhone: "+14045550109",
        liveTransferPhone: "+14045550188",
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

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.ready).toBe(true);
    expect(payload.capabilities.liveTransferEnabled).toBe(true);
    expect(payload.recoveryPolicy.explicitHumanRequest).toBe(
      "live_transfer_during_open_hours",
    );
    expect(payload.recoveryPolicy.liveTransferWindow).toBe(
      "configured_business_hours_only",
    );
  });

  test("rejects invalid dedicated live-transfer phone numbers", async () => {
    getOwnedBusiness.mockResolvedValue(makeBusiness());
    const next = jest.fn();

    await VoiceSettingsController.update(
      {
        user: { userId: "owner" },
        body: { liveTransferPhone: "123" },
      },
      response(),
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: "Enter a valid live-transfer phone number.",
      }),
    );
  });

  test("rejects attempts to enable call recording", async () => {
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
});
