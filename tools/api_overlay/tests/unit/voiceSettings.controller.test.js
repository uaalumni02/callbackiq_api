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

describe("VoiceSettingsController", () => {
  test("updates feature and voice settings together", async () => {
    const business = {
      features: { voiceAiEnabled: false, aiBookingEnabled: true },
      voiceSettings: {},
      set: jest.fn((path, value) => {
        if (path === "features.voiceAiEnabled") business.features.voiceAiEnabled = value;
        if (path === "voiceSettings") business.voiceSettings = value;
      }),
      save: jest.fn(),
    };
    getOwnedBusiness.mockResolvedValue(business);
    const req = {
      user: { userId: "owner" },
      body: {
        voiceAiEnabled: true,
        answerMode: "after_hours",
        overflowRingSeconds: 20,
        welcomeGreeting: "Thanks for calling.",
      },
    };
    const res = response();
    const next = jest.fn();

    await VoiceSettingsController.update(req, res, next);

    expect(business.save).toHaveBeenCalled();
    expect(business.features.voiceAiEnabled).toBe(true);
    expect(business.voiceSettings.answerMode).toBe("after_hours");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("requires transfer and recording acknowledgement before readiness", async () => {
    const previous = {
      ws: process.env.VOICE_WEBSOCKET_PUBLIC_URL,
      http: process.env.VOICE_HTTP_PUBLIC_URL,
      auth: process.env.TWILIO_AUTH_TOKEN,
      ack: process.env.VOICE_RECORDING_ACKNOWLEDGED,
    };

    process.env.VOICE_WEBSOCKET_PUBLIC_URL = "wss://api.callbackiq.com/ws/voice";
    process.env.VOICE_HTTP_PUBLIC_URL = "https://api.callbackiq.com";
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
    delete process.env.VOICE_RECORDING_ACKNOWLEDGED;

    const business = {
      features: { voiceAiEnabled: true, aiBookingEnabled: true },
      voiceSettings: {
        answerMode: "after_hours",
        overflowRingSeconds: 20,
        transferPhone: "",
        welcomeGreeting: "Thanks for calling.",
        recordingEnabled: true,
      },
    };
    getOwnedBusiness.mockResolvedValue(business);
    const req = { user: { userId: "owner" }, query: {} };
    const res = response();
    const next = jest.fn();

    await VoiceSettingsController.readiness(req, res, next);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.ready).toBe(false);
    expect(payload.data.checks.transferPhoneConfigured).toBe(false);
    expect(payload.data.checks.recordingAcknowledged).toBe(false);

    if (previous.ws === undefined) delete process.env.VOICE_WEBSOCKET_PUBLIC_URL;
    else process.env.VOICE_WEBSOCKET_PUBLIC_URL = previous.ws;
    if (previous.http === undefined) delete process.env.VOICE_HTTP_PUBLIC_URL;
    else process.env.VOICE_HTTP_PUBLIC_URL = previous.http;
    if (previous.auth === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previous.auth;
    if (previous.ack === undefined) delete process.env.VOICE_RECORDING_ACKNOWLEDGED;
    else process.env.VOICE_RECORDING_ACKNOWLEDGED = previous.ack;
  });

  test("passes readiness when required voice controls are configured", async () => {
    const previous = {
      ws: process.env.VOICE_WEBSOCKET_PUBLIC_URL,
      http: process.env.VOICE_HTTP_PUBLIC_URL,
      auth: process.env.TWILIO_AUTH_TOKEN,
      ack: process.env.VOICE_RECORDING_ACKNOWLEDGED,
    };

    process.env.VOICE_WEBSOCKET_PUBLIC_URL = "wss://api.callbackiq.com/ws/voice";
    process.env.VOICE_HTTP_PUBLIC_URL = "https://api.callbackiq.com";
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
    process.env.VOICE_RECORDING_ACKNOWLEDGED = "true";

    const business = {
      features: { voiceAiEnabled: true, aiBookingEnabled: true },
      voiceSettings: {
        answerMode: "overflow",
        overflowRingSeconds: 20,
        transferPhone: "+14045550100",
        welcomeGreeting: "Thanks for calling.",
        recordingEnabled: true,
      },
    };
    getOwnedBusiness.mockResolvedValue(business);
    const req = { user: { userId: "owner" }, query: {} };
    const res = response();
    const next = jest.fn();

    await VoiceSettingsController.readiness(req, res, next);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.ready).toBe(true);

    if (previous.ws === undefined) delete process.env.VOICE_WEBSOCKET_PUBLIC_URL;
    else process.env.VOICE_WEBSOCKET_PUBLIC_URL = previous.ws;
    if (previous.http === undefined) delete process.env.VOICE_HTTP_PUBLIC_URL;
    else process.env.VOICE_HTTP_PUBLIC_URL = previous.http;
    if (previous.auth === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previous.auth;
    if (previous.ack === undefined) delete process.env.VOICE_RECORDING_ACKNOWLEDGED;
    else process.env.VOICE_RECORDING_ACKNOWLEDGED = previous.ack;
  });

});
