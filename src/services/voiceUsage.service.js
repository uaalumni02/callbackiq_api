import VoiceUsageLedger from "../models/voiceUsageLedger.js";
import AlertService from "./alert.service.js";

const DAY_SECONDS = 24 * 60 * 60;
const clamp = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const utcKey = (date, type) => {
  const iso = new Date(date).toISOString();
  return type === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
};

const limitsFor = (business = {}) => {
  const settings = business.voiceSettings || {};
  return {
    dailySeconds: Math.round(
      clamp(settings.dailyVoiceMinutes, 240, 1, 100000) * 60,
    ),
    monthlySeconds: Math.round(
      clamp(settings.monthlyVoiceMinutes, 4000, 1, 1000000) * 60,
    ),
    hardCapEnabled: settings.voiceHardCapEnabled !== false,
    overageEnabled: settings.voiceOverageEnabled === true,
    warningThresholds: Array.isArray(settings.voiceUsageWarningThresholds)
      ? settings.voiceUsageWarningThresholds
      : [70, 85, 100],
  };
};

const getOrCreate = async ({ businessId, type, now }) =>
  VoiceUsageLedger.findOneAndUpdate(
    { business: businessId, periodType: type, periodKey: utcKey(now, type) },
    {
      $setOnInsert: {
        business: businessId,
        periodType: type,
        periodKey: utcKey(now, type),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

const usedSeconds = (ledger) =>
  Number(ledger?.completedSeconds || 0) + Number(ledger?.reservedSeconds || 0);

const maybeAlert = async ({ businessId, ledger, limitSeconds, thresholds }) => {
  if (!limitSeconds) return;
  const percent = Math.floor((usedSeconds(ledger) / limitSeconds) * 100);
  const crossed = thresholds
    .map(Number)
    .filter(Number.isFinite)
    .filter((threshold) => percent >= threshold)
    .sort((a, b) => a - b);

  for (const threshold of crossed) {
    if (ledger.thresholdAlertsSent?.includes(threshold)) continue;
    await AlertService.createSystemAlert({
      businessId,
      title: `Voice usage reached ${threshold}%`,
      message:
        threshold >= 100
          ? "The voice allowance is exhausted. New AI calls will use the configured callback fallback unless overages are enabled."
          : `Voice usage has reached ${percent}% of the ${ledger.periodType} allowance.`,
      priority: threshold >= 100 ? "high" : "medium",
      metadata: {
        source: "voice_usage_threshold",
        periodType: ledger.periodType,
        periodKey: ledger.periodKey,
        threshold,
        percent,
      },
      dedupeKey: `voice_usage:${ledger.periodType}:${ledger.periodKey}:${threshold}`,
    });
    ledger.thresholdAlertsSent.push(threshold);
  }
  await ledger.save();
};

export const reserveVoiceUsage = async ({
  business,
  sessionId,
  reserveSeconds = 60,
  now = new Date(),
}) => {
  const businessId = business?._id || business?.id || business;
  if (!businessId) {
    return { allowed: false, reason: "voice_usage_business_required" };
  }

  const limits = limitsFor(business);
  const [daily, monthly] = await Promise.all([
    getOrCreate({ businessId, type: "day", now }),
    getOrCreate({ businessId, type: "month", now }),
  ]);

  const requested = Math.round(clamp(reserveSeconds, 60, 15, DAY_SECONDS));
  const dailyWouldExceed = usedSeconds(daily) + requested > limits.dailySeconds;
  const monthlyWouldExceed =
    usedSeconds(monthly) + requested > limits.monthlySeconds;
  const exceeded = dailyWouldExceed || monthlyWouldExceed;

  if (
    exceeded &&
    limits.hardCapEnabled &&
    !limits.overageEnabled
  ) {
    await VoiceUsageLedger.updateMany(
      { _id: { $in: [daily._id, monthly._id] } },
      { $inc: { rejectedCalls: 1 }, $set: { lastSession: sessionId || null } },
    );
    return {
      allowed: false,
      reason: dailyWouldExceed
        ? "daily_voice_allowance_exhausted"
        : "monthly_voice_allowance_exhausted",
      daily: { usedSeconds: usedSeconds(daily), limitSeconds: limits.dailySeconds },
      monthly: {
        usedSeconds: usedSeconds(monthly),
        limitSeconds: limits.monthlySeconds,
      },
    };
  }

  await VoiceUsageLedger.updateMany(
    { _id: { $in: [daily._id, monthly._id] } },
    { $inc: { reservedSeconds: requested }, $set: { lastSession: sessionId || null } },
  );

  daily.reservedSeconds += requested;
  monthly.reservedSeconds += requested;
  await Promise.all([
    maybeAlert({
      businessId,
      ledger: daily,
      limitSeconds: limits.dailySeconds,
      thresholds: limits.warningThresholds,
    }),
    maybeAlert({
      businessId,
      ledger: monthly,
      limitSeconds: limits.monthlySeconds,
      thresholds: limits.warningThresholds,
    }),
  ]);

  return { allowed: true, reservedSeconds: requested };
};

export const reconcileVoiceUsage = async ({
  businessId,
  sessionId,
  reservedSeconds = 60,
  actualSeconds = 0,
  openAiInputTokens = 0,
  openAiOutputTokens = 0,
  twilioEstimatedCostCents = 0,
  openAiEstimatedCostCents = 0,
  transferAttempts = 0,
  now = new Date(),
}) => {
  if (!businessId) return;
  const query = {
    business: businessId,
    periodKey: { $in: [utcKey(now, "day"), utcKey(now, "month")] },
  };
  await VoiceUsageLedger.updateMany(query, {
    $inc: {
      reservedSeconds: -Math.max(0, Number(reservedSeconds) || 0),
      completedSeconds: Math.max(0, Number(actualSeconds) || 0),
      openAiInputTokens: Math.max(0, Number(openAiInputTokens) || 0),
      openAiOutputTokens: Math.max(0, Number(openAiOutputTokens) || 0),
      twilioEstimatedCostCents: Math.max(
        0,
        Number(twilioEstimatedCostCents) || 0,
      ),
      openAiEstimatedCostCents: Math.max(
        0,
        Number(openAiEstimatedCostCents) || 0,
      ),
      transferAttempts: Math.max(0, Number(transferAttempts) || 0),
    },
    $set: { lastSession: sessionId || null },
  });
  await VoiceUsageLedger.updateMany(
    { ...query, reservedSeconds: { $lt: 0 } },
    { $set: { reservedSeconds: 0 } },
  );
};

export const getVoiceUsageSummary = async ({ businessId, now = new Date() }) => {
  const ledgers = await VoiceUsageLedger.find({
    business: businessId,
    $or: [
      { periodType: "day", periodKey: utcKey(now, "day") },
      { periodType: "month", periodKey: utcKey(now, "month") },
    ],
  }).lean();
  return {
    day: ledgers.find((item) => item.periodType === "day") || null,
    month: ledgers.find((item) => item.periodType === "month") || null,
  };
};

export default {
  reserveVoiceUsage,
  reconcileVoiceUsage,
  getVoiceUsageSummary,
};
