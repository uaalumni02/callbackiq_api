import crypto from "node:crypto";
import mongoose from "mongoose";
import Intent from "../../models/integrationDisconnectIntent.js";
import Connection from "../../models/integrationConnection.js";
import Business from "../../models/business.js";
import { decryptSecret } from "./tokenEncryption.service.js";
import { googleHttpRequest } from "./googleHttpRequest.js";
import { numericSetting } from "../../config/numericSettings.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";
const credentials = "+accessTokenEncrypted +refreshTokenEncrypted";
/** Durably retains only encrypted credentials needed to revoke a grant; repeated snapshots deduplicate. */
export async function queueGoogleGrantRevocation(connection, session = null) {
  const accessTokenEncrypted = connection.accessTokenEncrypted || "",
    refreshTokenEncrypted = connection.refreshTokenEncrypted || "";
  const fingerprint = crypto
    .createHash("sha256")
    .update(refreshTokenEncrypted || accessTokenEncrypted || "no-token")
    .digest("hex");
  const channel = connection.metadata?.googleCalendar?.channel || {};
  return Intent.findOneAndUpdate(
    { business: connection.business, provider: "google_calendar", fingerprint },
    {
      $setOnInsert: {
        state: "pending",
        nextAttemptAt: new Date(),
        accessTokenEncrypted,
        refreshTokenEncrypted,
        watchChannelId: channel.id || "",
        watchResourceId: channel.resourceId || "",
      },
    },
    { upsert: true, returnDocument: "after", session },
  );
}
const revoke = async (intent) => {
  const access = intent.accessTokenEncrypted
    ? decryptSecret(intent.accessTokenEncrypted)
    : "";
  if (access && intent.watchChannelId && intent.watchResourceId) {
    try {
      await googleHttpRequest(
        "https://www.googleapis.com/calendar/v3/channels/stop",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: intent.watchChannelId,
            resourceId: intent.watchResourceId,
          }),
        },
      );
    } catch (error) {
      logOperationalError("google.disconnect_watch_stop_failed", error, {
        businessId: intent.business,
        intentId: intent._id,
      });
    }
  }
  const token = intent.refreshTokenEncrypted
    ? decryptSecret(intent.refreshTokenEncrypted)
    : access;
  if (!token) return;
  const response = await googleHttpRequest(
    "https://oauth2.googleapis.com/revoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    },
  );
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    if (response.status !== 400 || result.error !== "invalid_token")
      throw Object.assign(
        new Error("Google grant revocation remains unverified."),
        { code: "GOOGLE_REVOCATION_UNVERIFIED" },
      );
  }
};
const claimDisconnect = async (id, businessId, token, now) => {
  const intent = await Intent.findOneAndUpdate(
    {
      _id: id,
      business: businessId,
      $or: [
        { state: "pending", nextAttemptAt: { $lte: now } },
        { state: "processing", leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        state: "processing",
        leaseToken: token,
        leaseUntil: new Date(
          Date.now() + numericSetting("PILOT_GOOGLE_DISCONNECT_LEASE_MS"),
        ),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  ).select(credentials);
  return intent;
};
/** Claims and reconciles one disconnect; failures retain encrypted retry state rather than losing revocation. */
export async function processGoogleDisconnectIntent({ id, businessId }) {
  const token = crypto.randomUUID(),
    now = new Date();
  const intent = await claimDisconnect(id, businessId, token, now);
  if (!intent) return false;
  const fence = {
    _id: id,
    business: businessId,
    state: "processing",
    leaseToken: token,
  };
  try {
    await revoke(intent);
    const result = await Intent.updateOne(fence, {
      $set: {
        state: "completed",
        accessTokenEncrypted: "",
        refreshTokenEncrypted: "",
        lastErrorCode: "",
        completedAt: new Date(),
        purgeAt: new Date(
          Date.now() +
            numericSetting("PILOT_GOOGLE_DISCONNECT_RECEIPT_DAYS") * 86400000,
        ),
      },
      $unset: { leaseToken: 1, leaseUntil: 1 },
    });
    return result.modifiedCount === 1;
  } catch (error) {
    await Intent.updateOne(fence, {
      $set: {
        state: "pending",
        lastErrorCode: error.code || "GOOGLE_REVOCATION_FAILED",
        nextAttemptAt: new Date(
          Date.now() +
            Math.min(
              numericSetting("PILOT_GOOGLE_DISCONNECT_MAX_RETRY_MS"),
              numericSetting("PILOT_GOOGLE_DISCONNECT_RETRY_MS") *
                2 ** Math.min(intent.attempts, 7),
            ),
        ),
      },
      $unset: { leaseToken: 1, leaseUntil: 1 },
    });
    logOperationalError("google.disconnect_pending", error, {
      businessId,
      intentId: id,
    });
    return false;
  }
}
const clearConnection = async (connection, session) => {
  const result = await Connection.findOneAndUpdate(
    { _id: connection._id, business: connection.business },
    {
      $set: {
        status: "disconnected",
        accessTokenEncrypted: "",
        refreshTokenEncrypted: "",
        tokenExpiresAt: null,
        providerCalendarId: "",
        providerCalendarName: "",
        providerAccountId: "",
        providerAccountEmail: "",
        availabilityCalendarIds: [],
        oauthStateHash: "",
        oauthStateExpiresAt: null,
        watchChannelId: "",
        watchResourceId: "",
        watchExpiresAt: null,
        syncToken: "",
        disconnectedAt: new Date(),
        "metadata.googleCalendar": {},
      },
      $inc: { availabilityCacheVersion: 1, credentialGeneration: 1 },
    },
    { session, returnDocument: "after" },
  );
  await Business.updateOne(
    {
      _id: connection.business,
      "features.calendarProvider": { $in: ["google", "google_calendar"] },
    },
    { $set: { "features.calendarProvider": "internal" } },
    { session },
  );
  return result;
};
/** Disconnects locally in a transaction before network work; revocation remains durable until verified. */
export async function disconnectGoogleAccount(connection) {
  if (!connection) return null;
  const session = await mongoose.startSession();
  let intent, disconnected;
  try {
    await session.withTransaction(async () => {
      intent = await queueGoogleGrantRevocation(connection, session);
      disconnected = await clearConnection(connection, session);
    });
  } finally {
    await session.endSession();
  }
  const completed = await processGoogleDisconnectIntent({
    id: intent._id,
    businessId: connection.business,
  });
  disconnected.$locals.revocationPending = !completed;
  return disconnected;
}
/** Blocks reconnect while a previous grant is being revoked, preventing accidental revocation of a new grant. */
export async function assertGoogleReconnectAllowed(businessId) {
  if (
    await Intent.exists({ business: businessId, state: { $ne: "completed" } })
  )
    throw Object.assign(
      new Error(
        "Google disconnect is still being completed. Use internal scheduling until support verifies revocation.",
      ),
      { code: "GOOGLE_DISCONNECT_PENDING", statusCode: 409 },
    );
}
/** Bounded infrastructure sweep; all claims remain scoped to each selected business. */
export async function reconcileGoogleDisconnects(limit = 5) {
  const rows = await Intent.find({
    $or: [
      { state: "pending", nextAttemptAt: { $lte: new Date() } },
      { state: "processing", leaseUntil: { $lte: new Date() } },
    ],
  })
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(limit)
    .select("_id business")
    .setOptions({ allowCrossTenant: true })
    .lean();
  let completed = 0;
  for (const row of rows)
    completed += Number(
      await processGoogleDisconnectIntent({
        id: row._id,
        businessId: row.business,
      }),
    );
  return { processed: rows.length, completed };
}
