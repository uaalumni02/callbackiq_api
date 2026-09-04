import crypto from "crypto";

import CommunicationRouteRateLimit from "../models/communicationRouteRateLimit.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const stores = new Set();

const positiveInteger = (value, fallback, minimum = 1, maximum = 100000) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const hashKey = (parts) =>
  crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part || "")).join("|"))
    .digest("hex");

const getWindowStart = (now, windowMs) =>
  new Date(Math.floor(now / windowMs) * windowMs);

const reserveDistributed = async ({ keyHash, name, max, windowMs, now }) => {
  const windowStart = getWindowStart(now, windowMs);
  const identity = { keyHash, name, windowStart };

  try {
    const document = await CommunicationRouteRateLimit.findOneAndUpdate(
      {
        ...identity,
        $or: [{ count: { $lt: max } }, { count: { $exists: false } }],
      },
      {
        $setOnInsert: {
          ...identity,
          expiresAt: new Date(windowStart.getTime() + windowMs * 3),
        },
        $inc: { count: 1 },
      },
      { upsert: true, returnDocument: "after" },
    );

    return Boolean(document);
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
};

const shouldFailClosed = () =>
  String(process.env.COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED || "").toLowerCase() ===
    "true";

const sendRateLimitResponse = ({ res, twiml, resetAt, now }) => {
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  res.set("Retry-After", String(retryAfterSeconds));

  if (twiml) {
    return res
      .status(429)
      .type("text/xml")
      .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  return res.status(429).json({
    success: false,
    message: "Too many requests. Please try again shortly.",
    retryAfterSeconds,
  });
};

export const createCommunicationRouteRateLimit = ({
  name,
  max,
  windowMs,
  twiml = false,
  keyBuilder,
}) => {
  const entries = new Map();
  stores.add(entries);

  return async (req, res, next) => {
    const now = Date.now();
    const keyHash = hashKey([
      name,
      req.ip,
      req.path,
      ...(typeof keyBuilder === "function" ? keyBuilder(req) : []),
    ]);
    const existing = entries.get(keyHash);
    const current =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : existing;

    current.count += 1;
    entries.set(keyHash, current);

    if (entries.size > 5000) {
      for (const [entryKey, value] of entries.entries()) {
        if (value.resetAt <= now) entries.delete(entryKey);
      }
    }

    if (current.count > max) {
      return sendRateLimitResponse({ res, twiml, resetAt: current.resetAt, now });
    }

    if (
      CommunicationRouteRateLimit.db &&
      CommunicationRouteRateLimit.db.readyState !== 1
    ) {
      if (shouldFailClosed()) {
        return sendRateLimitResponse({
          res,
          twiml,
          resetAt: current.resetAt,
          now,
        });
      }
      return next();
    }

    try {
      const allowed = await reserveDistributed({
        keyHash,
        name,
        max,
        windowMs,
        now,
      });
      if (!allowed) {
        return sendRateLimitResponse({
          res,
          twiml,
          resetAt: getWindowStart(now, windowMs).getTime() + windowMs,
          now,
        });
      }
    } catch (error) {
      logOperationalError("communication_route_rate_limit.store_failed", error, {
        routeName: name,
        path: req.path,
      });
      if (shouldFailClosed()) {
        return sendRateLimitResponse({
          res,
          twiml,
          resetAt: current.resetAt,
          now,
        });
      }
    }

    return next();
  };
};

const phonePair = (req) => [
  req.body?.From || req.body?.Caller || "",
  req.body?.To || req.body?.Called || "",
];

export const twilioVoiceWebhookRateLimit = createCommunicationRouteRateLimit({
  name: "twilio-voice",
  max: positiveInteger(process.env.TWILIO_VOICE_WEBHOOKS_PER_MINUTE, 120),
  windowMs: 60_000,
  twiml: true,
  keyBuilder: phonePair,
});

export const twilioSmsWebhookRateLimit = createCommunicationRouteRateLimit({
  name: "twilio-sms",
  max: positiveInteger(process.env.TWILIO_SMS_WEBHOOKS_PER_MINUTE, 120),
  windowMs: 60_000,
  twiml: true,
  keyBuilder: phonePair,
});

export const twilioSmsFallbackWebhookRateLimit =
  createCommunicationRouteRateLimit({
    name: "twilio-sms-fallback",
    max: positiveInteger(
      process.env.TWILIO_SMS_FALLBACK_WEBHOOKS_PER_MINUTE,
      240,
    ),
    windowMs: 60_000,
    twiml: true,
    keyBuilder: phonePair,
  });

export const twilioStatusWebhookRateLimit = createCommunicationRouteRateLimit({
  name: "twilio-status",
  max: positiveInteger(process.env.TWILIO_STATUS_WEBHOOKS_PER_MINUTE, 600),
  windowMs: 60_000,
  twiml: true,
  keyBuilder: (req) => [req.body?.CallSid || req.body?.MessageSid || ""],
});

export const manualSmsRateLimit = createCommunicationRouteRateLimit({
  name: "manual-sms",
  max: positiveInteger(process.env.MANUAL_SMS_REQUESTS_PER_MINUTE, 60),
  windowMs: 60_000,
  keyBuilder: (req) => [req.user?.userId || "anonymous", req.body?.to || ""],
});

export const agentReplyRateLimit = createCommunicationRouteRateLimit({
  name: "agent-reply",
  max: positiveInteger(process.env.AGENT_REPLY_REQUESTS_PER_MINUTE, 30),
  windowMs: 60_000,
  keyBuilder: (req) => [
    req.user?.userId || "anonymous",
    req.body?.conversationId || "",
  ],
});

export const resetCommunicationRouteRateLimits = () => {
  for (const store of stores) store.clear();
};
