import { performance } from "node:perf_hooks";
import {
  recordTwilioWebhookLatency,
} from "../services/twilioWebhookLatency.service.js";
import {
  logOperationalEvent,
} from "../helpers/logging/safeLogger.js";

const voiceP95BudgetMs = () => {
  const configured = Number(process.env.TWILIO_VOICE_WEBHOOK_P95_BUDGET_MS);
  if (Number.isFinite(configured) && configured >= 1000) {
    return Math.min(14500, configured);
  }
  return 12000;
};

export const monitorTwilioVoiceWebhookLatency = (req, res, next) => {
  const started = performance.now();

  res.once("finish", () => {
    const snapshot = recordTwilioWebhookLatency({
      type: "voice",
      durationMs: performance.now() - started,
    });
    const budgetMs = voiceP95BudgetMs();
    const exceeded =
      snapshot.count >= 20 && snapshot.p95 >= budgetMs;

    if (exceeded || snapshot.count % 20 === 0) {
      logOperationalEvent(
        exceeded
          ? "twilio.voice.webhook_p95_budget_exceeded"
          : "twilio.voice.webhook_latency",
        {
          path: req.originalUrl,
          statusCode: res.statusCode,
          sampleCount: snapshot.count,
          latestMs: snapshot.latestMs,
          p50Ms: snapshot.p50,
          p95Ms: snapshot.p95,
          p99Ms: snapshot.p99,
          budgetMs,
          twilioHardCeilingMs: 15000,
        },
      );
    }
  });

  return next();
};

export default monitorTwilioVoiceWebhookLatency;
