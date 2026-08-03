import crypto from "crypto";
import VoiceAbuseSignal from "../models/voiceAbuseSignal.js";
import AlertService from "./alert.service.js";

const callerHash = (phone) =>
  crypto
    .createHash("sha256")
    .update(`${process.env.VOICE_ABUSE_HASH_SALT || "callbackiq"}:${String(phone || "")}`)
    .digest("hex");

const windowStart = (minutes) =>
  new Date(Date.now() - Math.max(1, Number(minutes) || 60) * 60_000);

export const evaluateCallerVelocity = async ({
  businessId,
  callerPhone,
  windowMinutes = 60,
  maxCalls = 10,
}) => {
  if (!businessId || !callerPhone) return { allowed: true };
  const hash = callerHash(callerPhone);
  const count = await VoiceAbuseSignal.countDocuments({
    business: businessId,
    callerHash: hash,
    signalType: "caller_velocity",
    occurredAt: { $gte: windowStart(windowMinutes) },
  });

  await VoiceAbuseSignal.create({
    business: businessId,
    callerHash: hash,
    signalType: "caller_velocity",
    severity: count + 1 >= maxCalls ? "high" : "low",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    metadata: { windowMinutes, maxCalls },
  });

  if (count + 1 < maxCalls) return { allowed: true, count: count + 1 };

  await AlertService.createSystemAlert({
    businessId,
    title: "Suspicious voice calling pattern",
    message: `A caller reached the voice line ${count + 1} times within ${windowMinutes} minutes. AI handling was restricted and the configured safe fallback was used.`,
    priority: "high",
    metadata: {
      source: "voice_fraud_velocity",
      callerHash: hash.slice(0, 12),
      count: count + 1,
      windowMinutes,
    },
    dedupeKey: `voice_fraud_velocity:${hash}:${new Date().toISOString().slice(0, 13)}`,
  });

  return { allowed: false, reason: "caller_velocity_limit", count: count + 1 };
};

export const recordAbuseSignal = async ({
  businessId,
  callerPhone,
  signalType,
  severity = "medium",
  metadata = {},
}) =>
  VoiceAbuseSignal.create({
    business: businessId,
    callerHash: callerHash(callerPhone),
    signalType,
    severity,
    metadata,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

export default { evaluateCallerVelocity, recordAbuseSignal };
