import {
  getTwilioWebhookLatencySnapshot,
  resetTwilioWebhookLatency,
} from "../../src/services/twilioWebhookLatency.service.js";
import {
  monitorTwilioVoiceWebhookLatency,
} from "../../src/middleware/twilio-webhook-latency.js";

jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  logOperationalEvent: jest.fn(),
}));

describe("Twilio voice webhook latency middleware", () => {
  beforeEach(() => resetTwilioWebhookLatency());

  test("records latency when the response finishes", () => {
    let finish;
    const req = { originalUrl: "/api/twilio/voice" };
    const res = {
      statusCode: 200,
      once: jest.fn((event, callback) => {
        if (event === "finish") finish = callback;
      }),
    };
    const next = jest.fn();

    monitorTwilioVoiceWebhookLatency(req, res, next);
    finish();

    expect(next).toHaveBeenCalledTimes(1);
    expect(getTwilioWebhookLatencySnapshot("voice").count).toBe(1);
  });
});
