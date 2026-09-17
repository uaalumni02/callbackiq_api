import crypto from "crypto";
import VoiceCallerWindow from "../models/voiceCallerWindow.js";
import VoiceAbuseSignal from "../models/voiceAbuseSignal.js";
import AlertService from "./alert.service.js";

const callerHash = (phone) =>
  crypto
    .createHash("sha256")
    .update(`${process.env.VOICE_ABUSE_HASH_SALT || "callbackiq"}:${String(phone || "")}`)
    .digest("hex");

// Bound memory even during abuse. Once full, unknown calls fail closed until
// entries age out; replays of recorded calls keep their original decision.
const MAX_WINDOW_ENTRIES = 2048;
export const evaluateCallerVelocity = async ({
  businessId, callerPhone, providerCallSid, sessionId,
  windowMinutes = 60, maxCalls = 10, now = new Date(),
}) => {
  const key = String(providerCallSid || sessionId || "").trim();
  if (!businessId || !callerPhone || !key) {
    return { allowed: false, reason: "caller_velocity_identity_required" };
  }
  const hash = callerHash(callerPhone);
  const id = `${businessId}:${hash}`;
  const minutes = Math.max(1, Math.min(1440, Number(windowMinutes) || 60));
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(maxCalls) || 10)));
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const pipeline = [
    { $set: { attempts: { $filter: {
      input: { $ifNull: ["$attempts", []] }, as: "attempt",
      cond: { $gt: ["$$attempt.at", cutoff] },
    } } } },
    { $set: {
      attempts: { $cond: [
        { $or: [
          { $in: [{ $literal: key }, "$attempts.key"] },
          { $gte: [{ $size: "$attempts" }, MAX_WINDOW_ENTRIES] },
        ] },
        "$attempts",
        { $concatArrays: ["$attempts", [{
          key: { $literal: key }, at: now,
          allowed: { $lt: [{ $size: "$attempts" }, limit] },
        }]] },
      ] },
      expiresAt: new Date(now.getTime() + minutes * 60_000),
    } },
  ];
  let result;
  try {
    result = await VoiceCallerWindow.findOneAndUpdate({ _id: id }, pipeline,
      { upsert: true, returnDocument: "after", updatePipeline: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Concurrent creation: rerun the admission against the winning document.
    result = await VoiceCallerWindow.findOneAndUpdate({ _id: id }, pipeline,
      { returnDocument: "after", updatePipeline: true });
  }
  if (!result) return { allowed: false, reason: "caller_velocity_unavailable" };
  const index = result.attempts.findIndex(attempt => attempt.key === key);
  const count = index < 0 ? MAX_WINDOW_ENTRIES + 1 : index + 1;
  if (index >= 0 && result.attempts[index].allowed) return { allowed: true, count };

  await AlertService.createSystemAlert({
    businessId,
    title: "Suspicious voice calling pattern",
    message: `A caller exceeded the ${limit}-call limit within ${minutes} minutes. AI handling was restricted and callback recovery was used.`,
    priority: "high",
    metadata: { source: "voice_fraud_velocity", callerHash: hash.slice(0, 12), count, windowMinutes: minutes },
    dedupeKey: `voice_fraud_velocity:${hash}:${now.toISOString().slice(0, 13)}`,
  });
  return { allowed: false, reason: "caller_velocity_limit", count };
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
