import mongoose from "mongoose";

import VoiceSettingsVersion from "../models/voiceSettingsVersion.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const snapshot = (business) => ({
  features: {
    voiceAiEnabled: Boolean(business?.features?.voiceAiEnabled),
    aiBookingEnabled: Boolean(business?.features?.aiBookingEnabled),
  },
  voiceSettings:
    business?.voiceSettings?.toObject?.() || { ...(business?.voiceSettings || {}) },
});

const applySnapshot = (business, value = {}) => {
  business.set(
    "features.voiceAiEnabled",
    Boolean(value?.features?.voiceAiEnabled),
  );
  business.set(
    "features.aiBookingEnabled",
    Boolean(value?.features?.aiBookingEnabled),
  );
  business.set("voiceSettings", value?.voiceSettings || {});
};

const isTransactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.codeName === "IllegalOperation" ||
  /transaction numbers are only allowed|does not support transactions|replica set/i.test(
    String(error?.message || ""),
  );

const nextVersion = async ({ businessId, mongoSession = null }) => {
  let query = VoiceSettingsVersion.findOne({ business: businessId })
    .sort({ version: -1 })
    .select("version");
  if (mongoSession) query = query.session(mongoSession);
  const latest = await query.lean();
  return Number(latest?.version || 0) + 1;
};

const createVersion = async ({
  business,
  version,
  publishedBy,
  reason,
  source,
  rolledBackFromVersion,
  mongoSession,
}) => {
  const documents = await VoiceSettingsVersion.create(
    [
      {
        business: business._id,
        version,
        settings: snapshot(business),
        publishedBy,
        reason: String(reason || "").trim().slice(0, 500),
        source,
        rolledBackFromVersion,
        publishedAt: new Date(),
      },
    ],
    mongoSession ? { session: mongoSession } : undefined,
  );
  return documents[0];
};

export const recordVoiceSettingsVersion = async ({
  business,
  publishedBy = null,
  reason = "",
  source = "dashboard",
  rolledBackFromVersion = null,
  mongoSession = null,
}) => {
  if (mongoSession) {
    const version = await nextVersion({ businessId: business._id, mongoSession });
    return createVersion({
      business,
      version,
      publishedBy,
      reason,
      source,
      rolledBackFromVersion,
      mongoSession,
    });
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const version = await nextVersion({ businessId: business._id });
    try {
      return await createVersion({
        business,
        version,
        publishedBy,
        reason,
        source,
        rolledBackFromVersion,
        mongoSession: null,
      });
    } catch (error) {
      if (error?.code !== 11000 || attempt === 4) throw error;
    }
  }
  throw new Error("Unable to allocate a voice settings version.");
};

const publishWithoutTransaction = async ({
  business,
  before,
  publishedBy,
  reason,
  source,
  rolledBackFromVersion,
}) => {
  await business.save();
  try {
    return await recordVoiceSettingsVersion({
      business,
      publishedBy,
      reason,
      source,
      rolledBackFromVersion,
    });
  } catch (versionError) {
    applySnapshot(business, before);
    await business.save().catch((restoreError) => {
      logOperationalError(
        "voice_settings.compensating_restore_failed",
        restoreError,
        { businessId: business._id },
      );
    });
    throw versionError;
  }
};

export const publishVoiceSettingsVersion = async ({
  business,
  previousSnapshot = null,
  publishedBy = null,
  reason = "",
  source = "dashboard",
  rolledBackFromVersion = null,
}) => {
  const before = previousSnapshot || snapshot(business);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const mongoSession = await mongoose.startSession();
    try {
      let published = null;
      await mongoSession.withTransaction(async () => {
        await business.save({ session: mongoSession });
        published = await recordVoiceSettingsVersion({
          business,
          publishedBy,
          reason,
          source,
          rolledBackFromVersion,
          mongoSession,
        });
      });
      if (!published) {
        throw new Error("Voice settings publication did not create a version record.");
      }
      return published;
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        const production =
          String(process.env.NODE_ENV || "development").toLowerCase() === "production";
        if (production) {
          const required = new Error(
            "Voice settings publication requires MongoDB transaction support in production.",
          );
          required.code = "VOICE_SETTINGS_TRANSACTIONS_REQUIRED";
          required.statusCode = 503;
          throw required;
        }
        return publishWithoutTransaction({
          business,
          before,
          publishedBy,
          reason,
          source,
          rolledBackFromVersion,
        });
      }
      if (error?.code === 11000 && attempt < 4) continue;
      throw error;
    } finally {
      await mongoSession.endSession();
    }
  }
  throw new Error("Unable to publish voice settings after concurrent updates.");
};

export const listVoiceSettingsVersions = ({ businessId, limit = 25 }) =>
  VoiceSettingsVersion.find({ business: businessId })
    .sort({ version: -1 })
    .limit(Math.max(1, Math.min(100, Number(limit) || 25)))
    .lean();

export const rollbackVoiceSettingsVersion = async ({
  business,
  version,
  publishedBy = null,
  reason = "",
}) => {
  const target = await VoiceSettingsVersion.findOne({
    business: business._id,
    version: Number(version),
  }).lean();
  if (!target) {
    const error = new Error("The requested voice settings version was not found.");
    error.code = "VOICE_SETTINGS_VERSION_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  const previousSnapshot = snapshot(business);
  applySnapshot(business, target.settings);
  const published = await publishVoiceSettingsVersion({
    business,
    previousSnapshot,
    publishedBy,
    reason: reason || `Rolled back to voice settings version ${target.version}.`,
    source: "rollback",
    rolledBackFromVersion: target.version,
  });
  return { business, target, published };
};

export default {
  listVoiceSettingsVersions,
  publishVoiceSettingsVersion,
  recordVoiceSettingsVersion,
  rollbackVoiceSettingsVersion,
};
