import ExternalRecordMapping from "../models/externalRecordMapping.js";
import IntegrationConnection from "../models/integrationConnection.js";
import IntegrationWebhookEvent from "../models/integrationWebhookEvent.js";
import { syncGoogleCalendar } from "../services/integrations/googleCalendarSync.service.js";

const processGoogle = async (event) => {
  if (!event.business) return;
  await syncGoogleCalendar({ businessId: event.business });
};

const processJobber = async (event) => {
  const webhook = event.payload?.data?.webHookEvent || event.payload?.webHookEvent || {};
  const connection = await IntegrationConnection.findOne({
    provider: "jobber",
    providerAccountId: String(webhook.accountId || ""),
  }).select("+accessTokenEncrypted +refreshTokenEncrypted");
  if (!connection) return;
  event.business = connection.business;
  if (webhook.topic === "APP_DISCONNECT") {
    connection.status = "disconnected";
    connection.accessTokenEncrypted = "";
    connection.refreshTokenEncrypted = "";
    connection.tokenExpiresAt = null;
  } else {
    connection.lastSuccessfulSyncAt = new Date();
    connection.metadata = {
      ...(connection.metadata || {}),
      jobber: {
        ...(connection.metadata?.jobber || {}),
        lastWebhook: {
          topic: webhook.topic || "",
          itemId: webhook.itemId || "",
          occurredAt: webhook.occurredAt || webhook.occuredAt || new Date().toISOString(),
        },
      },
    };
    connection.markModified("metadata");
    if (webhook.itemId) {
      await ExternalRecordMapping.updateMany(
        {
          business: connection.business,
          provider: "jobber",
          externalId: String(webhook.itemId),
        },
        { $set: { lastSyncedAt: new Date(), syncStatus: "synced", syncError: "" } },
      );
    }
  }
  await connection.save();
};

export const processIntegrationWebhookEvent = async (eventId) => {
  const event = await IntegrationWebhookEvent.findOneAndUpdate(
    { _id: eventId, status: { $in: ["queued", "failed"] } },
    { $set: { status: "processing", errorMessage: "" }, $inc: { attempts: 1 } },
    { new: true },
  );
  if (!event) return null;
  try {
    if (event.provider === "google_calendar") await processGoogle(event);
    else if (event.provider === "jobber") await processJobber(event);
    event.status = "processed";
    event.processedAt = new Date();
    event.errorMessage = "";
  } catch (error) {
    event.status = "failed";
    event.errorMessage = String(error.message || error).slice(0, 2000);
  }
  await event.save();
  return event;
};

export const processQueuedIntegrationWebhooks = async (limit = 25) => {
  const events = await IntegrationWebhookEvent.find({
    status: { $in: ["queued", "failed"] },
    attempts: { $lt: 6 },
  })
    .sort({ createdAt: 1 })
    .limit(Math.min(Number(limit) || 25, 100));
  const results = [];
  for (const event of events) {
    results.push(await processIntegrationWebhookEvent(event._id));
  }
  return results;
};
