import {
  getTwilioWebhookLatencySnapshot,
  recordTwilioWebhookLatency,
  resetTwilioWebhookLatency,
} from "../../src/services/twilioWebhookLatency.service.js";

describe("Twilio webhook latency metrics", () => {
  beforeEach(() => resetTwilioWebhookLatency());

  test("computes a rolling p95", () => {
    for (let i = 1; i <= 100; i += 1) {
      recordTwilioWebhookLatency({
        type: "voice",
        durationMs: i * 10,
      });
    }

    const snapshot = getTwilioWebhookLatencySnapshot("voice");
    expect(snapshot.count).toBe(100);
    expect(snapshot.p50).toBe(500);
    expect(snapshot.p95).toBe(950);
    expect(snapshot.p99).toBe(990);
  });

  test("caps the rolling sample window", () => {
    for (let i = 0; i < 600; i += 1) {
      recordTwilioWebhookLatency({
        type: "voice",
        durationMs: i,
      });
    }

    expect(
      getTwilioWebhookLatencySnapshot("voice").count,
    ).toBe(500);
  });
});
