#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const MARKER = "CALLBACKIQ_MARKETING_ATTRIBUTION_V1";

const fail = (message) => {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
};

const full = (relative) => path.join(root, relative);
const ensureRepo = () => {
  for (const relative of ["src/app.js", "src/models/business.js", "src/services/twilioSmsWebhook.service.js"]) {
    if (!fs.existsSync(full(relative))) {
      fail(`Run this script from the callbackiq_api repository root. Missing ${relative}.`);
    }
  }
};

const read = (relative) => fs.readFileSync(full(relative), "utf8");
const write = (relative, content) => {
  const target = full(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`);
  console.log(`updated ${relative}`);
};

const createOrReplaceGenerated = (relative, content) => {
  const current = fs.existsSync(full(relative)) ? read(relative) : "";
  if (current === content || current === `${content}\n`) {
    console.log(`unchanged ${relative}`);
    return;
  }
  if (current && !current.includes(MARKER)) {
    fail(`${relative} already exists and is not a generated attribution-v1 file.`);
  }
  write(relative, content);
};

const replaceOnce = (relative, needle, replacement, idempotencyNeedle = replacement) => {
  let content = read(relative);
  if (content.includes(idempotencyNeedle)) {
    console.log(`already patched ${relative}`);
    return;
  }
  if (!content.includes(needle)) {
    fail(`Could not find expected anchor in ${relative}. The repository may have changed. Anchor:\n${needle.slice(0, 220)}`);
  }
  content = content.replace(needle, replacement);
  write(relative, content);
};

const replaceAllExact = (relative, needle, replacement, minimum = 1) => {
  let content = read(relative);
  if (content.includes(replacement) && !content.includes(needle)) {
    console.log(`already patched ${relative}`);
    return;
  }
  const count = content.split(needle).length - 1;
  if (count < minimum) fail(`Expected at least ${minimum} occurrence(s) in ${relative}; found ${count}.`);
  content = content.split(needle).join(replacement);
  write(relative, content);
};

ensureRepo();

const marketingSourceModel = `// ${MARKER}
import mongoose from "mongoose";

const { Schema } = mongoose;

export const MARKETING_SOURCE_CHANNELS = [
  "google_ads",
  "google_lsa",
  "google_business_profile",
  "organic_search",
  "facebook",
  "instagram",
  "yelp",
  "angi",
  "direct_mail",
  "referral",
  "website",
  "other",
];

const MarketingSourceSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: 80,
    },
    nameKey: {
      type: String,
      trim: true,
      required: true,
      select: false,
    },
    channel: {
      type: String,
      enum: MARKETING_SOURCE_CHANNELS,
      default: "other",
      required: true,
    },
    campaign: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    status: {
      type: String,
      enum: ["active", "paused", "archived"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

MarketingSourceSchema.pre("validate", function normalizeName() {
  this.name = String(this.name || "").trim();
  this.nameKey = this.name.toLowerCase().replace(/\\s+/g, " ");
});

MarketingSourceSchema.index(
  { business: 1, nameKey: 1 },
  { unique: true },
);
MarketingSourceSchema.index({ business: 1, status: 1, createdAt: -1 });

const MarketingSource =
  mongoose.models.MarketingSource ||
  mongoose.model("MarketingSource", MarketingSourceSchema);

export default MarketingSource;
`;

const trackingNumberModel = `// ${MARKER}
import mongoose from "mongoose";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

const { Schema } = mongoose;

const TrackingNumberSchema = new Schema(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    marketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
      index: true,
    },
    kind: {
      type: String,
      enum: ["primary", "marketing"],
      default: "marketing",
      required: true,
    },
    isPrimary: { type: Boolean, default: false, index: true },
    phoneNumber: {
      type: String,
      trim: true,
      required: true,
    },
    phoneLookup: {
      type: String,
      trim: true,
      required: true,
      select: false,
    },
    provider: {
      type: String,
      enum: ["twilio"],
      default: "twilio",
    },
    providerSid: {
      type: String,
      trim: true,
      default: "",
      select: false,
    },
    status: {
      type: String,
      enum: ["pending", "active", "failed", "released"],
      default: "pending",
      index: true,
    },
    voiceEnabled: { type: Boolean, default: true },
    smsEnabled: { type: Boolean, default: true },
    senderAttached: { type: Boolean, default: false },
    smsReady: { type: Boolean, default: false },
    assignedAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    lastError: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
  },
  { timestamps: true },
);

TrackingNumberSchema.pre("validate", function normalizeNumber() {
  const normalized = normalizePhoneToE164(this.phoneNumber);
  if (!normalized) {
    this.invalidate("phoneNumber", "Tracking number must be valid E.164.");
    return;
  }
  this.phoneNumber = normalized;
  this.phoneLookup = normalized;
});

TrackingNumberSchema.index({ phoneLookup: 1 }, { unique: true });
TrackingNumberSchema.index(
  { providerSid: 1 },
  {
    unique: true,
    partialFilterExpression: { providerSid: { $gt: "" } },
  },
);
TrackingNumberSchema.index({
  business: 1,
  marketingSource: 1,
  status: 1,
  createdAt: -1,
});
TrackingNumberSchema.index({
  business: 1,
  isPrimary: 1,
  status: 1,
});

const TrackingNumber =
  mongoose.models.TrackingNumber ||
  mongoose.model("TrackingNumber", TrackingNumberSchema);

export default TrackingNumber;
`;

const attributionService = `// ${MARKER}
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import MarketingSource from "../models/marketingSource.js";
import TrackingNumber from "../models/trackingNumber.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

export const buildAttributionSnapshot = ({
  marketingSource = null,
  trackingNumber = null,
} = {}) => ({
  sourceId: marketingSource?._id ? String(marketingSource._id) : "",
  sourceName: String(marketingSource?.name || ""),
  channel: String(marketingSource?.channel || ""),
  campaign: String(marketingSource?.campaign || ""),
  trackingNumberId: trackingNumber?._id ? String(trackingNumber._id) : "",
  trackingNumber: String(trackingNumber?.phoneNumber || ""),
});

export const resolveTrackingNumberContext = async (
  phone,
  { activeOnly = true } = {},
) => {
  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return null;

  const number = await TrackingNumber.findOne({
    phoneLookup: normalized,
    ...(activeOnly ? { status: "active" } : {}),
  }).lean();

  if (!number) return null;

  const [business, marketingSource] = await Promise.all([
    Business.findById(number.business).lean(),
    number.marketingSource
      ? MarketingSource.findById(number.marketingSource).lean()
      : null,
  ]);

  if (
    !business ||
    (activeOnly &&
      (business.isActive === false ||
        (number.isPrimary && business.trackingNumber?.status !== "active")))
  ) {
    return null;
  }

  return {
    business,
    trackingNumber: number,
    marketingSource,
    attribution: buildAttributionSnapshot({
      marketingSource,
      trackingNumber: number,
    }),
  };
};

export const syncLatestAttribution = async ({
  businessId,
  leadId = null,
  conversationId = null,
  trackingNumber = null,
  marketingSource = null,
  calledPhone = "",
}) => {
  const attribution = buildAttributionSnapshot({
    marketingSource,
    trackingNumber,
  });
  const replyFromPhone =
    trackingNumber?.phoneNumber ||
    normalizePhoneToE164(calledPhone) ||
    "";

  const tasks = [];

  if (leadId) {
    tasks.push(
      Lead.updateOne(
        { _id: leadId, business: businessId },
        {
          $set: {
            latestMarketingSource: marketingSource?._id || null,
            latestTrackingNumber: trackingNumber?._id || null,
            latestAttribution: attribution,
          },
        },
      ),
    );
  }

  if (conversationId) {
    tasks.push(
      Conversation.updateOne(
        { _id: conversationId, business: businessId },
        {
          $set: {
            latestMarketingSource: marketingSource?._id || null,
            latestTrackingNumber: trackingNumber?._id || null,
            latestAttribution: attribution,
            ...(replyFromPhone ? { replyFromPhone } : {}),
          },
        },
      ),
    );
  }

  await Promise.all(tasks);
  return attribution;
};

export const getLatestCallAttribution = async ({
  businessId,
  leadId = null,
  customerPhone = "",
}) => {
  const filter = {
    business: businessId,
    marketingSource: { $ne: null },
  };

  if (leadId) {
    filter.lead = leadId;
  } else {
    const normalized = normalizePhoneToE164(customerPhone);
    if (!normalized) return null;
    filter.from = normalized;
  }

  const call = await CallLog.findOne(filter)
    .sort({ createdAt: -1 })
    .select("marketingSource trackingNumber attribution")
    .lean();

  if (!call) return null;

  return {
    marketingSource: call.marketingSource || null,
    trackingNumber: call.trackingNumber || null,
    attribution: call.attribution || {},
  };
};

export default {
  buildAttributionSnapshot,
  resolveTrackingNumberContext,
  syncLatestAttribution,
  getLatestCallAttribution,
};
`;

const marketingSourceService = `// ${MARKER}
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
    .replace(/\\/+$/, "");
  if (!/^https:\\/\\//i.test(base)) {
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
    voiceUrl: \`\${base}/api/twilio/voice\`,
    smsUrl: \`\${base}/api/twilio/sms\`,
    statusCallback: \`\${base}/api/twilio/status\`,
  };
};

const areaCodeFromPhone = (phone) => {
  const normalized = normalizePhoneToE164(phone);
  const digits = normalized?.replace(/\\D/g, "") || "";
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
      \`The Pro plan currently includes up to \${includedSourceNumbers()} additional marketing source numbers.\`,
      409,
    );
  }

  let sourceLease = null;
  let globalLease = null;
  let purchasedSid = "";
  let persisted = false;

  try {
    sourceLease = await acquireOperationLease({
      key: \`marketing-number:\${businessId}:\${sourceId}\`,
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
      friendlyName: \`CallBackIQ Source - \${String(source.name).slice(0, 40)}\`,
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
`;

const marketingController = `// ${MARKER}
import getOwnedBusiness from "../services/businessScope.service.js";
import {
  createMarketingSource,
  listMarketingSources,
  provisionMarketingTrackingNumber,
  updateMarketingSource,
} from "../services/marketingSource.service.js";

const ownedBusiness = (req) =>
  getOwnedBusiness({
    user: req.user,
    requestedBusinessId: req.query.businessId,
  });

const sendKnownError = (res, error) =>
  res.status(error?.statusCode || 500).json({
    success: false,
    code: error?.code || "MARKETING_ATTRIBUTION_ERROR",
    message: error?.message || "Marketing attribution request failed.",
  });

class MarketingAttributionController {
  static async list(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await listMarketingSources({ businessId: business._id });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }

  static async create(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await createMarketingSource({
        businessId: business._id,
        name: req.body?.name,
        channel: req.body?.channel,
        campaign: req.body?.campaign,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error?.statusCode || error?.code === 11000) {
        return sendKnownError(res, error);
      }
      return next(error);
    }
  }

  static async update(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await updateMarketingSource({
        businessId: business._id,
        sourceId: req.params.id,
        updates: req.body || {},
      });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }

  static async provisionNumber(req, res, next) {
    try {
      const business = await ownedBusiness(req);
      const data = await provisionMarketingTrackingNumber({
        businessId: business._id,
        sourceId: req.params.id,
      });
      return res.status(201).json({ success: true, data });
    } catch (error) {
      if (error?.statusCode) return sendKnownError(res, error);
      return next(error);
    }
  }
}

export default MarketingAttributionController;
`;

const marketingRoutes = `// ${MARKER}
import express from "express";
import MarketingAttributionController from "../controllers/marketingAttribution.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";

const router = express.Router();
router.use(checkAuth, checkSubscription);

router.get("/", MarketingAttributionController.list);
router.post("/", MarketingAttributionController.create);
router.patch("/:id", MarketingAttributionController.update);
router.post("/:id/tracking-number", MarketingAttributionController.provisionNumber);

export default router;
`;

const migrationScript = `// ${MARKER}
import "dotenv/config";
import connectDB from "../src/db/connection.js";
import Business from "../src/models/business.js";
import TrackingNumber from "../src/models/trackingNumber.js";
import { normalizePhoneToE164 } from "../src/voice/voicePhone.service.js";

await connectDB();

let scanned = 0;
let mirrored = 0;
let skipped = 0;

for await (const business of Business.find({
  phone: { $exists: true, $nin: [null, ""] },
}).select("+trackingNumber.providerSid")) {
  scanned += 1;
  const phoneNumber = normalizePhoneToE164(business.phone);
  if (!phoneNumber) {
    skipped += 1;
    continue;
  }

  await TrackingNumber.findOneAndUpdate(
    { phoneLookup: phoneNumber },
    {
      $setOnInsert: {
        business: business._id,
        marketingSource: null,
        kind: "primary",
        isPrimary: true,
        phoneNumber,
        phoneLookup: phoneNumber,
        provider: "twilio",
        providerSid: String(business.trackingNumber?.providerSid || ""),
        status:
          business.trackingNumber?.status === "active" ? "active" : "pending",
        voiceEnabled: true,
        smsEnabled: true,
        senderAttached:
          business.messagingCompliance?.senderAttached === true,
        smsReady: business.messagingCompliance?.smsReady === true,
        assignedAt:
          business.trackingNumber?.assignedAt || business.createdAt || new Date(),
        activatedAt: business.trackingNumber?.activatedAt || null,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  mirrored += 1;
}

console.log(
  JSON.stringify(
    {
      scanned,
      mirrored,
      skipped,
      note:
        "Business.phone remains authoritative during the compatibility migration. This script only creates TrackingNumber mirrors.",
    },
    null,
    2,
  ),
);
process.exit(0);
`;

createOrReplaceGenerated("src/models/marketingSource.js", marketingSourceModel);
createOrReplaceGenerated("src/models/trackingNumber.js", trackingNumberModel);
createOrReplaceGenerated("src/services/marketingAttribution.service.js", attributionService);
createOrReplaceGenerated("src/services/marketingSource.service.js", marketingSourceService);
createOrReplaceGenerated("src/controllers/marketingAttribution.js", marketingController);
createOrReplaceGenerated("src/routes/marketingAttribution.routes.js", marketingRoutes);
createOrReplaceGenerated("scripts/backfill-primary-tracking-numbers.mjs", migrationScript);

// App route registration.
replaceOnce(
  "src/app.js",
  'import revenueRecoveryRoutes from "./routes/revenueRecovery.routes.js";',
  'import revenueRecoveryRoutes from "./routes/revenueRecovery.routes.js";\nimport marketingAttributionRoutes from "./routes/marketingAttribution.routes.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1',
  "CALLBACKIQ_MARKETING_ATTRIBUTION_V1",
);
replaceOnce(
  "src/app.js",
  'app.use("/api/analytics/revenue-recovery", revenueRecoveryRoutes);',
  'app.use("/api/analytics/revenue-recovery", revenueRecoveryRoutes);\napp.use("/api/marketing-sources", marketingAttributionRoutes);',
  'app.use("/api/marketing-sources", marketingAttributionRoutes);',
);

// CallLog attribution is per-call and therefore the authoritative root.
replaceOnce(
  "src/models/callLog.js",
  `    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },

    from: {`,
  `    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },

    // ${MARKER}: attribution is captured when the phone rings, before outcome is known.
    marketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
      index: true,
    },
    trackingNumber: {
      type: Schema.Types.ObjectId,
      ref: "TrackingNumber",
      default: null,
      index: true,
    },
    attribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },

    from: {`,
  MARKER,
);
replaceOnce(
  "src/models/callLog.js",
  `CallLogSchema.index({
  business: 1,
  status: 1,
  createdAt: -1,
});`,
  `CallLogSchema.index({
  business: 1,
  status: 1,
  createdAt: -1,
});
CallLogSchema.index({
  business: 1,
  marketingSource: 1,
  createdAt: -1,
});`,
  "marketingSource: 1,\n  createdAt: -1",
);

// Lead retains operational source; latest attribution is explicitly separate.
replaceOnce(
  "src/models/lead.js",
  `    source: {
      type: String,
      enum: ["missed_call", "manual", "sms", "voice", "web", "other"],
      default: "manual",
    },
    summary:`,
  `    source: {
      type: String,
      enum: ["missed_call", "manual", "sms", "voice", "web", "other"],
      default: "manual",
    },
    // ${MARKER}: source above is operational channel, not marketing attribution.
    latestMarketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
    },
    latestTrackingNumber: {
      type: Schema.Types.ObjectId,
      ref: "TrackingNumber",
      default: null,
    },
    latestAttribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },
    summary:`,
  MARKER,
);

// Conversation remembers which owned number should reply to the customer.
replaceOnce(
  "src/models/conversation.js",
  `    customerName: { type: String, trim: true, default: "Customer" },
    status: {`,
  `    customerName: { type: String, trim: true, default: "Customer" },
    // ${MARKER}: keep replies on the same owned source number that received the inquiry.
    replyFromPhone: { type: String, trim: true, default: "" },
    latestMarketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
    },
    latestTrackingNumber: {
      type: Schema.Types.ObjectId,
      ref: "TrackingNumber",
      default: null,
    },
    latestAttribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },
    status: {`,
  MARKER,
);

// Appointment stores the attribution snapshot that was current when the booking was created.
replaceOnce(
  "src/models/appointment.js",
  `    bookedBy: {
      type: String,
      enum: ["ai", "customer", "staff"],
      default: "staff",
      required: true,
    },

    provider:`,
  `    bookedBy: {
      type: String,
      enum: ["ai", "customer", "staff"],
      default: "staff",
      required: true,
    },

    // ${MARKER}: immutable booking attribution snapshot.
    marketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
      index: true,
    },
    trackingNumber: {
      type: Schema.Types.ObjectId,
      ref: "TrackingNumber",
      default: null,
    },
    attribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },

    provider:`,
  MARKER,
);

// ConversionEvent remains backward compatible: source/channel stay; marketing attribution is additive.
replaceOnce(
  "src/models/conversionEvent.js",
  `    callLog: { type: Schema.Types.ObjectId, ref: "CallLog", default: null },
    type: {`,
  `    callLog: { type: Schema.Types.ObjectId, ref: "CallLog", default: null },
    // ${MARKER}: do not overload the existing source/channel fields.
    marketingSource: {
      type: Schema.Types.ObjectId,
      ref: "MarketingSource",
      default: null,
      index: true,
    },
    trackingNumber: {
      type: Schema.Types.ObjectId,
      ref: "TrackingNumber",
      default: null,
    },
    attribution: {
      sourceId: { type: String, trim: true, default: "" },
      sourceName: { type: String, trim: true, default: "" },
      channel: { type: String, trim: true, default: "" },
      campaign: { type: String, trim: true, default: "" },
      trackingNumberId: { type: String, trim: true, default: "" },
      trackingNumber: { type: String, trim: true, default: "" },
    },
    type: {`,
  MARKER,
);

// Dual-read Twilio routing: new TrackingNumber collection first, legacy Business.phone fallback second.
replaceOnce(
  "src/services/twilioBusinessResolver.service.js",
  'import Business from "../models/business.js";',
  'import Business from "../models/business.js";\nimport { resolveTrackingNumberContext } from "./marketingAttribution.service.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1',
  MARKER,
);
replaceOnce(
  "src/services/twilioBusinessResolver.service.js",
  "export const resolveBusinessByTwilioNumber = async (",
  "const resolveLegacyBusinessByTwilioNumber = async (",
  "resolveLegacyBusinessByTwilioNumber",
);
replaceOnce(
  "src/services/twilioBusinessResolver.service.js",
  `export const resolveBusinessFromWebhookPhones = async (
  phones = [],
  options = {},
) => {`,
  `export const resolveTwilioNumberContext = async (
  phone,
  options = {},
) => {
  const tracked = await resolveTrackingNumberContext(phone, options);
  if (tracked?.business) return tracked;

  const business = await resolveLegacyBusinessByTwilioNumber(phone, options);
  return business
    ? {
        business,
        trackingNumber: null,
        marketingSource: null,
        attribution: {
          sourceId: "",
          sourceName: "",
          channel: "",
          campaign: "",
          trackingNumberId: "",
          trackingNumber: String(business.phone || ""),
        },
      }
    : null;
};

export const resolveBusinessByTwilioNumber = async (phone, options = {}) =>
  (await resolveTwilioNumberContext(phone, options))?.business || null;

export const resolveBusinessFromWebhookPhones = async (
  phones = [],
  options = {},
) => {`,
  "export const resolveTwilioNumberContext = async",
);
replaceOnce(
  "src/services/twilioBusinessResolver.service.js",
  `export default {
  resolveBusinessByTwilioNumber,
  resolveBusinessFromWebhookPhones,
};`,
  `export default {
  resolveTwilioNumberContext,
  resolveBusinessByTwilioNumber,
  resolveBusinessFromWebhookPhones,
};`,
  "resolveTwilioNumberContext,\n  resolveBusinessByTwilioNumber",
);

// Allow outbound SMS from any active owned TrackingNumber, while preserving primary-number behavior.
replaceOnce(
  "src/services/twilioSmsService.js",
  'import Business from "../models/business.js";',
  'import Business from "../models/business.js";\nimport TrackingNumber from "../models/trackingNumber.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1',
  MARKER,
);
replaceOnce(
  "src/services/twilioSmsService.js",
  `  const resolvedBusinessId = resolvedBusiness._id || resolvedBusiness.id;
  const configuredFrom = requiredText(resolvedBusiness.phone, "business SMS phone");
  if (from && normalizePhone(from) !== normalizePhone(configuredFrom)) {
    const error = new Error("The requested SMS sender is not assigned to the authenticated business.");
    error.code = "SMS_SENDER_NOT_OWNED";
    throw error;
  }`,
  `  const resolvedBusinessId = resolvedBusiness._id || resolvedBusiness.id;
  const primaryFrom = requiredText(
    resolvedBusiness.phone,
    "business SMS phone",
  );
  let configuredFrom = primaryFrom;
  const requestedFrom = normalizePhone(from);

  // ${MARKER}: source-number conversations may reply from the same owned number.
  if (requestedFrom && requestedFrom !== normalizePhone(primaryFrom)) {
    const ownedTrackingNumber = await TrackingNumber.findOne({
      business: resolvedBusinessId,
      phoneLookup: requestedFrom,
      status: "active",
      smsEnabled: true,
      smsReady: true,
    })
      .select("phoneNumber")
      .lean();

    if (!ownedTrackingNumber?.phoneNumber) {
      const error = new Error(
        "The requested SMS sender is not an active messaging-ready number owned by this business.",
      );
      error.code = "SMS_SENDER_NOT_OWNED";
      throw error;
    }
    configuredFrom = ownedTrackingNumber.phoneNumber;
  }`,
  MARKER,
);

// Webhooks capture attribution before knowing whether the call will be answered or missed.
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  'import { resolveBusinessByTwilioNumber, resolveBusinessFromWebhookPhones } from "./twilioBusinessResolver.service.js";',
  'import { resolveBusinessByTwilioNumber, resolveBusinessFromWebhookPhones, resolveTwilioNumberContext } from "./twilioBusinessResolver.service.js";\nimport { syncLatestAttribution } from "./marketingAttribution.service.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1',
  MARKER,
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `const saveOutbound = async ({ business, conversation, lead, to, body, sent, generatedBy, usageCategory, actorType, metadata }) => {`,
  `const saveOutbound = async ({ business, conversation, lead, from = "", to, body, sent, generatedBy, usageCategory, actorType, metadata }) => {`,
  "lead, from = \"\", to",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `    from: business.phone,
    to,
    body: sent?.body || body,`,
  `    from: from || business.phone,
    to,
    body: sent?.body || body,`,
  "from: from || business.phone",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `    const business = await resolveBusinessByTwilioNumber(twilioNumber);
    logOperationalEvent("twilio.voice.business_resolved", {`,
  `    const numberContext = await resolveTwilioNumberContext(twilioNumber);
    const business = numberContext?.business || null;
    logOperationalEvent("twilio.voice.business_resolved", {`,
  "const numberContext = await resolveTwilioNumberContext(twilioNumber)",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `          providerCallId: callSid,
          missedCallTextSent: false,`,
  `          providerCallId: callSid,
          marketingSource: numberContext?.marketingSource?._id || null,
          trackingNumber: numberContext?.trackingNumber?._id || null,
          attribution: numberContext?.attribution || {},
          missedCallTextSent: false,`,
  "marketingSource: numberContext?.marketingSource?._id",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `    const { lead, conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone,
      source: "missed_call",
      reopenEligible: true,
    });
    await CallLog.findByIdAndUpdate`,
  `    const { lead, conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone,
      source: "missed_call",
      reopenEligible: true,
    });
    await syncLatestAttribution({
      businessId: business._id,
      leadId: lead._id,
      conversationId: conversation._id,
      trackingNumber: numberContext?.trackingNumber || null,
      marketingSource: numberContext?.marketingSource || null,
      calledPhone: twilioNumber,
    });
    await CallLog.findByIdAndUpdate`,
  "syncLatestAttribution({\n      businessId: business._id,\n      leadId: lead._id",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `          from: business.phone,
          to: customerPhone,
          body: starterText,
          actorType: "webhook",
          source: "missed_call_recovery",`,
  `          from: numberContext?.trackingNumber?.phoneNumber || business.phone,
          to: customerPhone,
          body: starterText,
          actorType: "webhook",
          source: "missed_call_recovery",`,
  "from: numberContext?.trackingNumber?.phoneNumber || business.phone",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `          await saveOutbound({
            business,
            conversation,
            lead,
            to: customerPhone,
            body: starterText,`,
  `          await saveOutbound({
            business,
            conversation,
            lead,
            from: numberContext?.trackingNumber?.phoneNumber || business.phone,
            to: customerPhone,
            body: starterText,`,
  "from: numberContext?.trackingNumber?.phoneNumber || business.phone,\n            to: customerPhone",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `    const business = await resolveBusinessByTwilioNumber(to);
    logOperationalEvent("twilio.sms.received", {`,
  `    const numberContext = await resolveTwilioNumberContext(to);
    const business = numberContext?.business || null;
    logOperationalEvent("twilio.sms.received", {`,
  "const numberContext = await resolveTwilioNumberContext(to)",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `    const { lead, conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: from,
      body: body || (media.length ? "Attachment received" : ""),
      source: "sms",
      reopenEligible: true,
    });

    const inboundMessage`,
  `    const { lead, conversation } = await getOrCreateSmsLeadAndConversation({
      business,
      customerPhone: from,
      body: body || (media.length ? "Attachment received" : ""),
      source: "sms",
      reopenEligible: true,
    });
    await syncLatestAttribution({
      businessId: business._id,
      leadId: lead._id,
      conversationId: conversation._id,
      trackingNumber: numberContext?.trackingNumber || null,
      marketingSource: numberContext?.marketingSource || null,
      calledPhone: to,
    });

    const inboundMessage`,
  "calledPhone: to,\n    });\n\n    const inboundMessage",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `          segmentCount: 0,
        },`,
  `          segmentCount: 0,
          metadata: {
            attribution: numberContext?.attribution || {},
          },
        },`,
  "attribution: numberContext?.attribution || {}",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `    from: business.phone,
    to,
    body: commandResult.reply,
    allowOptedOut: commandResult.allowOptedOutReply,`,
  `    from: conversation.replyFromPhone || business.phone,
    to,
    body: commandResult.reply,
    allowOptedOut: commandResult.allowOptedOutReply,`,
  "from: conversation.replyFromPhone || business.phone,\n    to,\n    body: commandResult.reply",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `      business,
      conversation,
      lead,
      to,
      body: commandResult.reply,`,
  `      business,
      conversation,
      lead,
      from: conversation.replyFromPhone || business.phone,
      to,
      body: commandResult.reply,`,
  "from: conversation.replyFromPhone || business.phone,\n      to,\n      body: commandResult.reply",
);
replaceOnce(
  "src/services/twilioSmsWebhook.service.js",
  `        from: business.phone,
        to: from,
        body: reply,
        actorType: "webhook",
        source: "inbound_mms_acknowledgement",`,
  `        from: conversation.replyFromPhone || business.phone,
        to: from,
        body: reply,
        actorType: "webhook",
        source: "inbound_mms_acknowledgement",`,
  "from: conversation.replyFromPhone || business.phone,\n        to: from,\n        body: reply",
);

// AI SMS replies continue on the attributed number.
replaceAllExact(
  "src/services/messaging/inboundSmsJobProcessor.service.js",
  "from: business.phone,",
  "from: conversation.replyFromPhone || business.phone,",
  2,
);

// Appointment attribution is resolved from the call layer, not from Lead.source.
replaceOnce(
  "src/services/scheduling/appointment.service.js",
  'import Appointment from "../../models/appointment.js";',
  'import Appointment from "../../models/appointment.js";\nimport CallLog from "../../models/callLog.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1',
  MARKER,
);
replaceOnce(
  "src/services/scheduling/appointment.service.js",
  `const createHold = async ({
  business,
  service,
  input,`,
  `const resolveAppointmentAttribution = async ({ businessId, input }) => {
  if (input?.marketingSource || input?.trackingNumber || input?.attribution) {
    return {
      marketingSource: input.marketingSource || null,
      trackingNumber: input.trackingNumber || null,
      attribution: input.attribution || {},
    };
  }

  const filter = {
    business: businessId,
    marketingSource: { $ne: null },
  };
  if (input?.lead) {
    filter.lead = input.lead;
  } else if (input?.customerPhone) {
    filter.from = String(input.customerPhone).trim();
  } else {
    return { marketingSource: null, trackingNumber: null, attribution: {} };
  }

  const call = await CallLog.findOne(filter)
    .sort({ createdAt: -1 })
    .select("marketingSource trackingNumber attribution")
    .lean();

  return {
    marketingSource: call?.marketingSource || null,
    trackingNumber: call?.trackingNumber || null,
    attribution: call?.attribution || {},
  };
};

const createHold = async ({
  business,
  service,
  input,`,
  "const resolveAppointmentAttribution = async",
);
replaceOnce(
  "src/services/scheduling/appointment.service.js",
  `  const timeZone = input.timezone || business.timezone || "America/New_York";
  const capacity = await getSlotCapacity({`,
  `  const timeZone = input.timezone || business.timezone || "America/New_York";
  const appointmentAttribution = await resolveAppointmentAttribution({
    businessId,
    input,
  });
  const capacity = await getSlotCapacity({`,
  "const appointmentAttribution = await resolveAppointmentAttribution",
);
replaceOnce(
  "src/services/scheduling/appointment.service.js",
  `    bookedBy: input.bookedBy || "staff",
    provider: businessCalendarProviderName(business),`,
  `    bookedBy: input.bookedBy || "staff",
    marketingSource: appointmentAttribution.marketingSource,
    trackingNumber: appointmentAttribution.trackingNumber,
    attribution: appointmentAttribution.attribution,
    provider: businessCalendarProviderName(business),`,
  "marketingSource: appointmentAttribution.marketingSource",
);

// Conversion events inherit booking attribution without changing legacy source semantics.
replaceOnce(
  "src/services/conversionEvent.service.js",
  `    callLogId = null,
    type,
    channel = "manual",`,
  `    callLogId = null,
    marketingSourceId = null,
    trackingNumberId = null,
    attribution = {},
    type,
    channel = "manual",`,
  "marketingSourceId = null",
);
replaceOnce(
  "src/services/conversionEvent.service.js",
  `        callLog: callLogId,
        type,
        channel,`,
  `        callLog: callLogId,
        marketingSource: marketingSourceId,
        trackingNumber: trackingNumberId,
        attribution,
        type,
        channel,`,
  "marketingSource: marketingSourceId",
);
replaceOnce(
  "src/services/conversionEvent.service.js",
  `      appointmentId: appointment._id,
      type: "appointment_booked",
      channel,`,
  `      appointmentId: appointment._id,
      marketingSourceId: appointment.marketingSource || null,
      trackingNumberId: appointment.trackingNumber || null,
      attribution: appointment.attribution || {},
      type: "appointment_booked",
      channel,`,
  "marketingSourceId: appointment.marketingSource || null",
);

// New all-call marketing-source analytics; keep legacy sources() for recovery-channel compatibility.
replaceOnce(
  "src/services/analytics/revenueRecovery.service.js",
  'import Lead from "../../models/lead.js";',
  'import Lead from "../../models/lead.js";\nimport MarketingSource from "../../models/marketingSource.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1',
  MARKER,
);
replaceOnce(
  "src/services/analytics/revenueRecovery.service.js",
  `  static async lostOpportunities({ businessId, startDate, endDate, limit = 100 }) {`,
  `  static async marketingSources({ businessId, startDate, endDate }) {
    const { start, end } = getRange({ startDate, endDate });
    const dateFilter = { $gte: start, $lte: end };
    const missedStatuses = ["missed", "voicemail", "failed", "busy", "no_answer"];

    const [sourceDocuments, callRows, bookingRows, recoveredRows] =
      await Promise.all([
        MarketingSource.find({
          business: businessId,
          status: { $ne: "archived" },
        }).lean(),
        CallLog.aggregate([
          { $match: { business: businessId, createdAt: dateFilter } },
          {
            $group: {
              _id: "$marketingSource",
              totalCalls: { $sum: 1 },
              answeredCalls: {
                $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] },
              },
              missedCalls: {
                $sum: {
                  $cond: [{ $in: ["$status", missedStatuses] }, 1, 0],
                },
              },
              recoveredCalls: {
                $sum: { $cond: ["$recovered", 1, 0] },
              },
            },
          },
        ]),
        Appointment.aggregate([
          {
            $match: {
              business: businessId,
              status: { $in: ["confirmed", "completed", "no_show"] },
              confirmedAt: dateFilter,
            },
          },
          {
            $group: {
              _id: "$marketingSource",
              bookedJobs: { $sum: 1 },
              estimatedBookedRevenue: { $sum: "$estimatedValue" },
              actualBookedRevenue: { $sum: "$actualRevenue" },
            },
          },
        ]),
        ConversionEvent.aggregate([
          {
            $match: {
              business: businessId,
              type: "appointment_booked",
              occurredAt: dateFilter,
              "metadata.recovered": true,
            },
          },
          {
            $group: {
              _id: "$marketingSource",
              recoveredBookedJobs: { $sum: 1 },
              estimatedRecoveredRevenue: { $sum: "$estimatedValue" },
              actualRecoveredRevenue: { $sum: "$actualRevenue" },
            },
          },
        ]),
      ]);

    const rows = new Map();
    const keyFor = (id) => (id ? String(id) : "unattributed");
    const ensure = (id) => {
      const key = keyFor(id);
      if (!rows.has(key)) {
        rows.set(key, {
          sourceId: id ? String(id) : null,
          name: id ? "Unknown source" : "Unattributed",
          channel: id ? "other" : "unattributed",
          campaign: "",
          totalCalls: 0,
          answeredCalls: 0,
          missedCalls: 0,
          recoveredCalls: 0,
          bookedJobs: 0,
          recoveredBookedJobs: 0,
          estimatedBookedRevenue: 0,
          actualBookedRevenue: 0,
          estimatedRecoveredRevenue: 0,
          actualRecoveredRevenue: 0,
        });
      }
      return rows.get(key);
    };

    for (const source of sourceDocuments) {
      Object.assign(ensure(source._id), {
        name: source.name,
        channel: source.channel,
        campaign: source.campaign || "",
        status: source.status,
      });
    }
    for (const row of callRows) Object.assign(ensure(row._id), row);
    for (const row of bookingRows) Object.assign(ensure(row._id), row);
    for (const row of recoveredRows) Object.assign(ensure(row._id), row);

    return [...rows.values()]
      .filter((row) => row.sourceId || row.totalCalls || row.bookedJobs)
      .sort(
        (left, right) =>
          right.totalCalls - left.totalCalls ||
          right.actualBookedRevenue - left.actualBookedRevenue,
      );
  }

  static async lostOpportunities({ businessId, startDate, endDate, limit = 100 }) {`,
  "static async marketingSources",
);
replaceOnce(
  "src/controllers/revenueRecovery.js",
  `  static async sources(req, res, next) {
    try { return res.json({ success: true, data: await RevenueRecoveryService.sources(await getContext(req)) }); }
    catch (error) { return next(error); }
  }`,
  `  static async sources(req, res, next) {
    try { return res.json({ success: true, data: await RevenueRecoveryService.sources(await getContext(req)) }); }
    catch (error) { return next(error); }
  }
  static async marketingSources(req, res, next) {
    try {
      return res.json({
        success: true,
        data: await RevenueRecoveryService.marketingSources(await getContext(req)),
      });
    } catch (error) { return next(error); }
  }`,
  "static async marketingSources",
);
replaceOnce(
  "src/routes/revenueRecovery.routes.js",
  'router.get("/sources", RevenueRecoveryController.sources);',
  'router.get("/sources", RevenueRecoveryController.sources);\nrouter.get("/marketing-sources", RevenueRecoveryController.marketingSources);',
  'router.get("/marketing-sources"',
);

// README: append a durable current-state section instead of rewriting unrelated documentation.
{
  const relative = "README.md";
  let content = read(relative);
  if (!content.includes("## Marketing Source → Revenue Attribution")) {
    content += `

## Marketing Source → Revenue Attribution

CallBackIQ now treats marketing attribution as a measurement layer around the existing recovery engine rather than as a replacement for Voice AI or SMS.

The owner workflow remains **Home → Inbox → Appointments → Needs Attention → Settings**. Marketing attribution answers a different question: **where did every tracked call come from, what happened to it, and which opportunities did CallBackIQ recover?**

### Attribution model

- \`MarketingSource\` stores logical sources such as Google Ads, Google LSA, Google Business Profile, Facebook, Yelp, direct mail, referral, and other sources.
- \`TrackingNumber\` stores telephony resources separately from marketing sources. This keeps the model compatible with future number pools/DNI without coupling one source permanently to one number.
- \`CallLog\` is the authoritative attribution root because attribution is captured when the call arrives, before the final call outcome is known.
- \`Lead.source\` remains an operational channel field (\`missed_call\`, \`sms\`, \`voice\`, etc.). It is intentionally **not** reused as a marketing source.
- Appointments and conversion events store attribution references plus immutable snapshots so historical reports remain understandable after a source is renamed.
- Twilio routing is dual-read during migration: the new \`TrackingNumber\` mapping is checked first and the existing \`Business.phone\` mapping remains a compatibility fallback.
- Replies to a source-number conversation remain on that owned source number when it is active and messaging-ready.

### Owner APIs

\`GET /api/marketing-sources\` lists configured sources, source numbers, plan limits, and provisioning state.

\`POST /api/marketing-sources\` creates a source label.

\`PATCH /api/marketing-sources/:id\` updates a source.

\`POST /api/marketing-sources/:id/tracking-number\` assigns an additional Twilio source number. Source-number purchases are restricted to active paid subscriptions and require the primary number plus carrier messaging registration to be ready.

\`GET /api/analytics/revenue-recovery/marketing-sources\` returns all-call source performance including total calls, answered calls, missed calls, recovered calls, bookings, total booked value, and recovered value. The existing \`/sources\` endpoint remains available for operational/recovery-channel reporting.

### Compatibility migration

Run:

\`\`\`bash
node scripts/backfill-primary-tracking-numbers.mjs
\`\`\`

The migration mirrors each existing \`Business.phone\` into the new \`TrackingNumber\` collection. It does **not** remove or repurpose \`Business.phone\`; the legacy field stays in place during the compatibility period.

### Pricing

The customer-facing Pro price is now **$99/month** with a 14-day free trial. Pro includes the primary CallBackIQ recovery number and up to **3 additional marketing source tracking numbers** by default. The source-number limit can be changed with \`ATTRIBUTION_INCLUDED_SOURCE_NUMBERS\`.

**Stripe is authoritative for the actual amount charged.** Before deploying the $99 offer, create/select a recurring $99/month Stripe Price and set \`STRIPE_PRO_PRICE_ID\` to that Price ID. Changing UI copy does not modify an existing Stripe Price.

`;
    write(relative, content);
  } else {
    console.log("README.md already contains attribution section");
  }
}

console.log(`
${MARKER} applied.

Next:
  1. node scripts/backfill-primary-tracking-numbers.mjs
  2. run the full API Jest/coverage/hardening suite
  3. verify STRIPE_PRO_PRICE_ID points to a $99/month recurring Stripe Price
  4. live-test one primary-number call and one marketing-source-number call before production
`);
