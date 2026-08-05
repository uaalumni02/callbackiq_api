import crypto from "crypto";
import WebhookEvent from "../../models/webhookEvent.js";

const DEFAULT_LEASE_MS = 60_000;
const leaseMs = () => {
  const value = Number(process.env.TWILIO_WEBHOOK_LEASE_MS);
  return Number.isFinite(value) && value >= 10_000 ? value : DEFAULT_LEASE_MS;
};
const isDuplicateKeyError = (error) => error?.code === 11000;

export const claimTwilioWebhookEvent = async ({
  businessId,
  eventType,
  eventKey,
  providerEventId,
  requestMetadata = {},
}) => {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs());

  try {
    const event = await WebhookEvent.create({
      business: businessId,
      provider: "twilio",
      eventType,
      eventKey,
      providerEventId,
      status: "processing",
      attemptCount: 1,
      leaseToken,
      leaseExpiresAt,
      processingStartedAt: now,
      requestMetadata,
      firstReceivedAt: now,
      lastReceivedAt: now,
    });
    return { claimed: true, duplicate: false, reclaimed: false, leaseToken, event };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const reclaimed = await WebhookEvent.findOneAndUpdate(
    {
      business: businessId,
      provider: "twilio",
      eventType,
      eventKey,
      $or: [
        { status: "failed" },
        { status: "processing", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        leaseToken,
        leaseExpiresAt,
        processingStartedAt: now,
        lastReceivedAt: now,
        failedAt: null,
        failureReason: "",
        requestMetadata,
      },
      $inc: { attemptCount: 1, duplicateCount: 1 },
    },
    { returnDocument: "after" },
  );
  if (reclaimed) {
    return { claimed: true, duplicate: true, reclaimed: true, leaseToken, event: reclaimed };
  }

  const event = await WebhookEvent.findOneAndUpdate(
    { business: businessId, provider: "twilio", eventType, eventKey },
    { $inc: { duplicateCount: 1 }, $set: { lastReceivedAt: now } },
    { returnDocument: "after" },
  );
  return { claimed: false, duplicate: true, reclaimed: false, leaseToken: "", event };
};

export const heartbeatTwilioWebhookEvent = async ({ eventId, leaseToken }) =>
  WebhookEvent.updateOne(
    { _id: eventId, status: "processing", leaseToken },
    { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs()) } },
  );

export const completeTwilioWebhookEvent = async (
  eventId,
  { statusCode = 200, contentType = "text/xml", responseBody = "" } = {},
) => {
  if (!eventId) return null;
  return WebhookEvent.findByIdAndUpdate(
    eventId,
    {
      status: "completed",
      completedAt: new Date(),
      failedAt: null,
      failureReason: "",
      leaseToken: "",
      leaseExpiresAt: null,
      responseStatusCode: statusCode,
      responseContentType: contentType,
      responseBody,
      lastReceivedAt: new Date(),
    },
    { returnDocument: "after" },
  );
};

export const failTwilioWebhookEvent = async (
  eventId,
  error,
  { statusCode = 200, contentType = "text/xml", responseBody = "" } = {},
) => {
  if (!eventId) return null;
  const failureReason =
    error instanceof Error ? error.message : String(error || "Unknown error");
  return WebhookEvent.findByIdAndUpdate(
    eventId,
    {
      status: "failed",
      failedAt: new Date(),
      failureReason,
      leaseToken: "",
      leaseExpiresAt: null,
      responseStatusCode: statusCode,
      responseContentType: contentType,
      responseBody,
      lastReceivedAt: new Date(),
    },
    { returnDocument: "after" },
  );
};
