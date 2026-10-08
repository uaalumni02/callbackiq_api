import { createAwaitedInsertBatch } from '../database/awaitedInsertBatch.js';
// CALLBACKIQ_WEBHOOK_SETTLEMENT_V2
import { settleWebhookEvent } from "./webhookSettlementBatch.service.js";
import { readOnlySnapshot } from "../database/readOnlySnapshot.js";
import { sameTurnBatch } from "../database/sameTurnBatch.js";
import crypto from "crypto";
import WebhookEvent from "../../models/webhookEvent.js";

const insertWebhookEvent = createAwaitedInsertBatch(WebhookEvent);

const DEFAULT_LEASE_MS = 5_000;
const DEFAULT_DUPLICATE_WAIT_MS = 5_500;

const leaseMs = () => {
  const value = Number(process.env.TWILIO_WEBHOOK_LEASE_MS);
  return Number.isFinite(value) && value >= 3_000
    ? Math.min(30_000, value)
    : DEFAULT_LEASE_MS;
};

const isDuplicateKeyError = (error) => error?.code === 11000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const event = await insertWebhookEvent({
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
    return {
      claimed: true,
      duplicate: false,
      reclaimed: false,
      leaseToken,
      event,
    };
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
    return {
      claimed: true,
      duplicate: true,
      reclaimed: true,
      leaseToken,
      event: reclaimed,
    };
  }

  const event = await WebhookEvent.findOneAndUpdate(
    { business: businessId, provider: "twilio", eventType, eventKey },
    { $inc: { duplicateCount: 1 }, $set: { lastReceivedAt: now } },
    { returnDocument: "after" },
  );

  return {
    claimed: false,
    duplicate: true,
    reclaimed: false,
    leaseToken: "",
    event,
  };
};

// Keep each event's token/status fence. Combining renewals reduces round trips,
// but never combines their ownership predicates or acknowledges before MongoDB.
export const heartbeatTwilioWebhookEvent = sameTurnBatch(async renewals => {
  const operations = renewals.map(({ eventId, leaseToken }) => ({
    updateOne: {
      filter: { _id: eventId, status: "processing", leaseToken },
      update: { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs()) } },
    },
  }));
  if (operations.length === 1) {
    const { filter, update } = operations[0].updateOne;
    return [await WebhookEvent.updateOne(filter, update)];
  }
  await WebhookEvent.bulkWrite(operations, { ordered: false });
  // Bulk counts cannot identify individual matches. Callers only await success;
  // a nonmatching/expired owner's predicate remains a no-op, as with updateOne.
  return renewals.map(() => undefined);
}, { name: "webhookHeartbeats" });

export const waitForTwilioWebhookEventSettlement = async (
  eventId,
  {
    maxWaitMs = DEFAULT_DUPLICATE_WAIT_MS,
    pollMs = 150,
  } = {},
) => {
  if (!eventId) return null;
  const started = Date.now();
  const safePollMs = Math.max(50, Math.min(500, Number(pollMs) || 150));
  const safeWaitMs = Math.max(0, Math.min(8_000, Number(maxWaitMs) || 0));

  while (true) {
    const event = await WebhookEvent.findById(eventId);
    if (!event) return null;
    if (event.status !== "processing") return event;

    const expiresAt = event.leaseExpiresAt
      ? new Date(event.leaseExpiresAt).getTime()
      : 0;
    if (!expiresAt || expiresAt <= Date.now()) return event;
    if (Date.now() - started >= safeWaitMs) return event;

    await delay(safePollMs);
  }
};

export const completeTwilioWebhookEvent = async (
  eventId,
  {
    leaseToken = "",
    readOnly = false,
    statusCode = 200,
    contentType = "text/xml",
    responseBody = "",
  } = {},
) => {
  if (!eventId || !leaseToken) return null;

  return readOnlySnapshot(WebhookEvent, settleWebhookEvent(
    { _id: eventId, status: "processing", leaseToken },
    {
      $set: {
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
    },
    { returnDocument: "after" },
  ), readOnly);
};

export const failTwilioWebhookEvent = async (
  eventId,
  error,
  {
    leaseToken = "",
    statusCode = 200,
    contentType = "text/xml",
    responseBody = "",
  } = {},
) => {
  if (!eventId || !leaseToken) return null;

  const failureReason =
    error instanceof Error
      ? error.message
      : String(error || "Unknown error");

  return WebhookEvent.findOneAndUpdate(
    { _id: eventId, status: "processing", leaseToken },
    {
      $set: {
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
    },
    { returnDocument: "after" },
  );
};
