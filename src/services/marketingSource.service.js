// CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import Business from "../models/business.js";
import MarketingSource, {
  MARKETING_SOURCE_CHANNELS,
} from "../models/marketingSource.js";
import Subscription from "../models/subscription.js";
import TrackingNumber from "../models/trackingNumber.js";
import { attachPhoneNumberToBusinessMessagingRegistration } from "./a2pMessagingRegistration.service.js";
import {
  acquireOperationLease,
  releaseOperationLease,
} from "./operationLease.service.js";
import {
  assertAutomaticProvisioningBudget,
  provisioningBudgetEnabled,
} from "./trialTelecomGuard.service.js";
import { getTwilioClient } from "./twilioSmsService.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

const DEFAULT_INCLUDED_SOURCE_NUMBERS = 3;

const sourceError = (code, message, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const includedSourceNumbers = () =>
  Math.max(
    0,
    Number(
      process.env.ATTRIBUTION_INCLUDED_SOURCE_NUMBERS ||
        DEFAULT_INCLUDED_SOURCE_NUMBERS,
    ),
  );

const webhookBase = () => {
  const base = String(
    process.env.TWILIO_WEBHOOK_BASE_URL ||
      process.env.VOICE_HTTP_PUBLIC_URL ||
      process.env.PUBLIC_API_URL ||
      "",
  )
    .trim()
    .replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) {
    throw sourceError(
      "TWILIO_WEBHOOK_BASE_URL_REQUIRED",
      "A public HTTPS webhook base URL is required before a marketing tracking number can be assigned.",
      503,
    );
  }
  return base;
};

const webhookUrls = () => {
  const base = webhookBase();
  return {
    voiceUrl: `${base}/api/twilio/voice`,
    smsUrl: `${base}/api/twilio/sms`,
    statusCallback: `${base}/api/twilio/status`,
  };
};

const areaCodeFromPhone = (phone) => {
  const normalized = normalizePhoneToE164(phone);
  const digits = normalized?.replace(/\D/g, "") || "";
  return digits.length === 11 && digits.startsWith("1")
    ? Number(digits.slice(1, 4))
    : undefined;
};

const loadBusiness = async (businessId) =>
  Business.findById(businessId).select(
    "+messagingCompliance.messagingServiceSid +trackingNumber.providerSid",
  );

const requirePaidPlan = async (businessId) => {
  const subscription = await Subscription.findOne({ business: businessId }).lean();
  if (!subscription?.isActive || subscription.status !== "active") {
    throw sourceError(
      "PAID_PLAN_REQUIRED_FOR_SOURCE_NUMBERS",
      "Additional marketing source numbers are available after the paid Pro plan is active. You can configure source labels during the trial.",
      402,
    );
  }
  return subscription;
};

export const listMarketingSources = async ({ businessId }) => {
  const [sources, numbers, subscription] = await Promise.all([
    MarketingSource.find({
      business: businessId,
      status: { $ne: "archived" },
    })
      .sort({ createdAt: 1 })
      .lean(),
    TrackingNumber.find({
      business: businessId,
      kind: "marketing",
      status: { $ne: "released" },
    })
      .select("-providerSid -phoneLookup")
      .sort({ createdAt: 1 })
      .lean(),
    Subscription.findOne({ business: businessId }).lean(),
  ]);

  const numbersBySource = new Map();
  for (const number of numbers) {
    const key = String(number.marketingSource || "");
    if (!numbersBySource.has(key)) numbersBySource.set(key, []);
    numbersBySource.get(key).push(number);
  }

  const limit = includedSourceNumbers();
  const activeAdditionalNumbers = numbers.filter(
    (number) => number.status === "active",
  ).length;

  return {
    sources: sources.map((source) => ({
      ...source,
      trackingNumbers: numbersBySource.get(String(source._id)) || [],
    })),
    channels: MARKETING_SOURCE_CHANNELS,
    limits: {
      includedAdditionalNumbers: limit,
      activeAdditionalNumbers,
      remainingAdditionalNumbers: Math.max(0, limit - activeAdditionalNumbers),
      paidPlanActive:
        subscription?.isActive === true && subscription?.status === "active",
    },
  };
};

export const createMarketingSource = async ({
  businessId,
  name,
  channel = "other",
  campaign = "",
}) => {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw sourceError(
      "MARKETING_SOURCE_NAME_REQUIRED",
      "Enter a name for the marketing source.",
      400,
    );
  }
  if (!MARKETING_SOURCE_CHANNELS.includes(channel)) {
    throw sourceError(
      "INVALID_MARKETING_SOURCE_CHANNEL",
      "Choose a supported marketing source channel.",
      400,
    );
  }

  try {
    return await MarketingSource.create({
      business: businessId,
      name: normalizedName,
      channel,
      campaign: String(campaign || "").trim(),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw sourceError(
        "MARKETING_SOURCE_ALREADY_EXISTS",
        "A marketing source with that name already exists.",
        409,
      );
    }
    throw error;
  }
};

export const updateMarketingSource = async ({
  businessId,
  sourceId,
  updates = {},
}) => {
  const allowed = {};
  if (updates.name !== undefined) allowed.name = String(updates.name || "").trim();
  if (updates.campaign !== undefined) {
    allowed.campaign = String(updates.campaign || "").trim();
  }
  if (updates.channel !== undefined) {
    if (!MARKETING_SOURCE_CHANNELS.includes(updates.channel)) {
      throw sourceError(
        "INVALID_MARKETING_SOURCE_CHANNEL",
        "Choose a supported marketing source channel.",
        400,
      );
    }
    allowed.channel = updates.channel;
  }
  if (updates.status !== undefined) {
    if (!["active", "paused"].includes(updates.status)) {
      throw sourceError(
        "INVALID_MARKETING_SOURCE_STATUS",
        "Marketing sources can be active or paused.",
        400,
      );
    }
    allowed.status = updates.status;
  }

  const source = await MarketingSource.findOneAndUpdate(
    { _id: sourceId, business: businessId, status: { $ne: "archived" } },
    { $set: allowed },
    { returnDocument: "after", runValidators: true },
  );
  if (!source) {
    throw sourceError("MARKETING_SOURCE_NOT_FOUND", "Marketing source not found.", 404);
  }
  return source;
};

export const provisionMarketingTrackingNumber = async ({
  businessId,
  sourceId,
}) => {
  const source = await MarketingSource.findOne({
    _id: sourceId,
    business: businessId,
    status: "active",
  });
  if (!source) {
    throw sourceError(
      "MARKETING_SOURCE_NOT_FOUND",
      "Create or reactivate the marketing source before assigning a number.",
      404,
    );
  }

  const existing = await TrackingNumber.findOne({
    business: businessId,
    marketingSource: sourceId,
    kind: "marketing",
    status: "active",
  }).select("-providerSid -phoneLookup");
  if (existing) return existing;

  await requirePaidPlan(businessId);

  const business = await loadBusiness(businessId);
  if (!business || business.isActive === false) {
    throw sourceError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }
  if (business.trackingNumber?.status !== "active" || !business.phone) {
    throw sourceError(
      "PRIMARY_TRACKING_NUMBER_REQUIRED",
      "Activate the primary CallBackIQ number before adding marketing source numbers.",
    );
  }
  if (
    business.messagingCompliance?.a2pStatus !== "registered" ||
    business.messagingCompliance?.smsReady !== true
  ) {
    throw sourceError(
      "SMS_REGISTRATION_REQUIRED",
      "Finish carrier messaging registration before adding a marketing source number so missed-call recovery works on that number.",
    );
  }

  const activeCount = await TrackingNumber.countDocuments({
    business: businessId,
    kind: "marketing",
    status: "active",
  });
  if (activeCount >= includedSourceNumbers()) {
    throw sourceError(
      "MARKETING_SOURCE_NUMBER_LIMIT_REACHED",
      `The Pro plan currently includes up to ${includedSourceNumbers()} additional marketing source numbers.`,
      409,
    );
  }

  let sourceLease = null;
  let globalLease = null;
  let purchasedSid = "";
  let persisted = false;

  try {
    sourceLease = await acquireOperationLease({
      key: `marketing-number:${businessId}:${sourceId}`,
      ttlMs: 120_000,
      busyCode: "MARKETING_NUMBER_PROVISIONING_IN_PROGRESS",
      busyMessage:
        "A tracking number is already being assigned to this marketing source.",
      busyStatusCode: 409,
      waitMs: 3_000,
      retryDelayMs: 100,
    });

    const raceWinner = await TrackingNumber.findOne({
      business: businessId,
      marketingSource: sourceId,
      kind: "marketing",
      status: "active",
    }).select("-providerSid -phoneLookup");
    if (raceWinner) return raceWinner;

    if (provisioningBudgetEnabled()) {
      globalLease = await acquireOperationLease({
        key: "tracking-number:global-auto-provision",
        ttlMs: 120_000,
        busyCode: "TWILIO_GLOBAL_PROVISIONING_IN_PROGRESS",
        busyMessage:
          "Another tracking-number purchase is being finalized. Retry shortly.",
        busyStatusCode: 409,
        waitMs: 5_000,
        retryDelayMs: 100,
      });
    }
    await assertAutomaticProvisioningBudget();

    const client = getTwilioClient();
    const areaCode = areaCodeFromPhone(business.forwardingPhone);
    const candidates = await client
      .availablePhoneNumbers("US")
      .local.list({
        ...(areaCode ? { areaCode } : {}),
        smsEnabled: true,
        voiceEnabled: true,
        limit: 1,
      });

    const selected = candidates?.[0]?.phoneNumber;
    if (!selected) {
      throw sourceError(
        "NO_MARKETING_TRACKING_NUMBER_AVAILABLE",
        "No SMS/voice-capable local tracking number is currently available.",
        503,
      );
    }

    const urls = webhookUrls();
    const incoming = await client.incomingPhoneNumbers.create({
      phoneNumber: selected,
      friendlyName: `CallBackIQ Source - ${String(source.name).slice(0, 40)}`,
      voiceMethod: "POST",
      voiceUrl: urls.voiceUrl,
      smsMethod: "POST",
      smsUrl: urls.smsUrl,
      statusCallbackMethod: "POST",
      statusCallback: urls.statusCallback,
    });

    purchasedSid = String(incoming?.sid || "");
    if (!purchasedSid) {
      throw sourceError(
        "TRACKING_NUMBER_PROVIDER_RESPONSE_INVALID",
        "Twilio did not return a phone-number identifier.",
        502,
      );
    }

    const a2pState = await attachPhoneNumberToBusinessMessagingRegistration({
      client,
      business,
      phoneNumberSid: purchasedSid,
    });

    if (a2pState?.senderAttached === false) {
      throw sourceError(
        "MARKETING_NUMBER_SENDER_ATTACH_FAILED",
        "The tracking number was purchased but could not be attached to the business messaging registration.",
        502,
      );
    }

    const normalized = normalizePhoneToE164(
      incoming.phoneNumber || selected,
    );
    const number = await TrackingNumber.create({
      business: businessId,
      marketingSource: sourceId,
      kind: "marketing",
      isPrimary: false,
      phoneNumber: normalized,
      provider: "twilio",
      providerSid: purchasedSid,
      status: "active",
      voiceEnabled: true,
      smsEnabled: true,
      senderAttached: true,
      smsReady: true,
      assignedAt: new Date(),
      activatedAt: new Date(),
    });
    persisted = true;
    return number;
  } catch (error) {
    if (purchasedSid && !persisted) {
      try {
        await getTwilioClient().incomingPhoneNumbers(purchasedSid).remove();
      } catch (cleanupError) {
        if (Number(cleanupError?.status || cleanupError?.statusCode || 0) !== 404) {
          console.error("[marketing-attribution] orphan number cleanup failed", {
            businessId: String(businessId),
            sourceId: String(sourceId),
            providerSid: purchasedSid,
            code: cleanupError?.code || cleanupError?.status || "unknown",
          });
        }
      }
    }
    throw error;
  } finally {
    await releaseOperationLease(globalLease);
    await releaseOperationLease(sourceLease);
  }
};

export default {
  listMarketingSources,
  createMarketingSource,
  updateMarketingSource,
  provisionMarketingTrackingNumber,
};
