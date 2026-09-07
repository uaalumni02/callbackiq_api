import { safeConsole } from "../helpers/logging/safeLogger.js";
import "dotenv/config";
import mongoose from "mongoose";

import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import TrialRedemption from "../models/trialRedemption.js";
import { buildTrialIdentity } from "../helpers/billing/trial.js";

const APPLY = process.argv.includes("--apply");
const MONGO_URI = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error("MONGO_URL, MONGODB_URI, or MONGO_URI is required");
}

const stats = {
  subscriptionsScanned: 0,
  businessesMissing: 0,
  ownersMissing: 0,
  wouldCreate: 0,
  created: 0,
  wouldCanonicalize: 0,
  canonicalized: 0,
  existing: 0,
  conflicts: 0,
  errors: 0,
};

const identityQuery = ({ ownerId, emailKey, phoneKey }) => {
  const checks = [];
  if (ownerId) checks.push({ owner: ownerId });
  if (emailKey) checks.push({ emailKey });
  if (phoneKey) checks.push({ phoneKey });
  return checks.length ? { $or: checks } : { _id: null };
};

const canonicalizeExisting = async (
  redemption,
  business,
  ownerId,
  stripeSubscriptionId = "",
) => {
  const identity = buildTrialIdentity(business, ownerId);
  const update = {};

  if (identity.emailKey && redemption.emailKey !== identity.emailKey) {
    update.emailKey = identity.emailKey;
  }
  if (identity.phoneKey && redemption.phoneKey !== identity.phoneKey) {
    update.phoneKey = identity.phoneKey;
  }
  if (stripeSubscriptionId && !redemption.stripeSubscriptionId) {
    update.stripeSubscriptionId = stripeSubscriptionId;
  }

  if (!Object.keys(update).length) return;
  stats.wouldCanonicalize += 1;
  if (!APPLY) return;

  try {
    await TrialRedemption.updateOne({ _id: redemption._id }, { $set: update });
    stats.canonicalized += 1;
  } catch (error) {
    if (error?.code === 11000) {
      // Another permanent lock already owns the canonical identity. Keep both
      // historical audit rows; future canonical lookups remain blocked.
      stats.conflicts += 1;
      safeConsole.warn("Canonicalization conflict (kept both locks):", {
        redemptionId: String(redemption._id),
        businessId: String(business._id),
      });
      return;
    }
    throw error;
  }
};

const run = async () => {
  await mongoose.connect(MONGO_URI);
  await TrialRedemption.init();

  const existingRedemptions = await TrialRedemption.find({}).lean();
  for (const redemption of existingRedemptions) {
    try {
      const business = await Business.findById(redemption.business).lean();
      if (!business) continue;
      await canonicalizeExisting(
        redemption,
        business,
        redemption.owner || business.owner,
        redemption.stripeSubscriptionId || "",
      );
    } catch (error) {
      stats.errors += 1;
      safeConsole.error("Unable to canonicalize redemption:", {
        redemptionId: String(redemption._id),
        message: error.message,
      });
    }
  }

  // trialUsedAt is the historical source of truth that a lifetime trial was
  // consumed, including old controller paths that failed to write a redemption.
  const cursor = Subscription.find({ trialUsedAt: { $ne: null } }).cursor();

  for await (const subscription of cursor) {
    stats.subscriptionsScanned += 1;
    try {
      const business = await Business.findById(subscription.business).lean();
      if (!business) {
        stats.businessesMissing += 1;
        continue;
      }

      const ownerId = business.owner;
      if (!ownerId) {
        stats.ownersMissing += 1;
        continue;
      }

      const identity = buildTrialIdentity(business, ownerId);
      if (!identity.emailKey) {
        stats.errors += 1;
        safeConsole.warn("Historical trial has no usable email identity:", {
          businessId: String(business._id),
        });
        continue;
      }

      const existing = await TrialRedemption.findOne(identityQuery(identity));
      if (existing) {
        stats.existing += 1;
        await canonicalizeExisting(
          existing.toObject(),
          business,
          ownerId,
          subscription.stripeSubscriptionId || "",
        );
        continue;
      }

      stats.wouldCreate += 1;
      if (!APPLY) continue;

      try {
        await TrialRedemption.create({
          business: business._id,
          owner: ownerId,
          emailKey: identity.emailKey,
          phoneKey: identity.phoneKey,
          stripeSubscriptionId: subscription.stripeSubscriptionId || "",
          grantedBy: "self",
          redeemedAt:
            subscription.trialUsedAt ||
            subscription.trialStartedAt ||
            new Date(),
        });
        stats.created += 1;
      } catch (error) {
        if (error?.code === 11000) {
          stats.conflicts += 1;
          continue;
        }
        throw error;
      }
    } catch (error) {
      stats.errors += 1;
      safeConsole.error("Unable to backfill historical trial:", {
        subscriptionId: String(subscription._id),
        businessId: String(subscription.business),
        message: error.message,
      });
    }
  }

  safeConsole.log(
    JSON.stringify({ mode: APPLY ? "apply" : "dry-run", ...stats }, null, 2),
  );

  if (stats.errors > 0) process.exitCode = 1;
};

run()
  .catch((error) => {
    safeConsole.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
