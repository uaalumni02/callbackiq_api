import { randomUUID } from 'node:crypto';
import { withDistributedLease } from './distributedLease.service.js';
import BillingEvent from "../models/billingEvent.js";

const PROCESSING_LEASE_MS = 10 * 60 * 1000;

const getBusinessId = (event) =>
  event?.data?.object?.metadata?.businessId || null;

const getResourceId = (event) =>
  event?.data?.object?.id ||
  event?.data?.object?.subscription ||
  event?.data?.object?.customer ||
  "";

const reserveNewStripeEvent = async (event, requestId) => {
  const now = new Date();

  return BillingEvent.create({
    provider: "stripe",
    providerEventId: event.id,
    eventType: event.type,
    livemode: Boolean(event.livemode),
    status: "processing",
    processingToken: randomUUID(),
    business: getBusinessId(event),
    resourceId: getResourceId(event),
    requestId,
    attempts: 1,
    processingStartedAt: now,
    metadata: {
      apiVersion: event.api_version || "",
      created: event.created || null,
    },
  });
};

export const reserveStripeEvent = async (event, requestId = "") => {
  if (!event?.id || !event?.type) {
    const error = new Error("Stripe event id and type are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const record = await reserveNewStripeEvent(event, requestId);

    return {
      duplicate: false,
      retry: false,
      record,
    };
  } catch (error) {
    if (error?.code !== 11000) throw error;

    /*
     * A provider retry may reclaim a failed event or a processing lease left
     * behind by a crashed worker. A live processing lease remains a duplicate.
     */
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const reclaimed = await BillingEvent.findOneAndUpdate(
      {
        provider: "stripe",
        providerEventId: event.id,
        $or: [
          { status: "failed" },
          {
            status: "processing",
            processingStartedAt: { $lt: staleBefore },
          },
        ],
      },
      {
        $set: {
          status: "processing",
          processingToken: randomUUID(),
          requestId,
          failureReason: "",
          failedAt: null,
          processingStartedAt: now,
        },
        $inc: {
          attempts: 1,
        },
      },
      {
        returnDocument: "after",
      },
    );

    if (reclaimed) {
      return {
        duplicate: false,
        retry: true,
        record: reclaimed,
      };
    }

    const record = await BillingEvent.findOneAndUpdate(
      {
        provider: "stripe",
        providerEventId: event.id,
      },
      {
        $inc: { attempts: 1 },
      },
      {
        returnDocument: "after",
      },
    );

    return {
      duplicate: true,
      retry: false,
      record,
    };
  }
};

export const markStripeEventProcessed = async (
  providerEventId,
  { ignored = false, businessId = null, processingToken = null } = {},
) => {
  const set = {
    status: ignored ? "ignored" : "processed",
    processedAt: new Date(),
    failureReason: "",
    failedAt: null,
    processingStartedAt: null,
    processingToken: null,
  };

  if (businessId) set.business = businessId;

  return BillingEvent.findOneAndUpdate(
    {
      provider: "stripe",
      providerEventId,
      processingToken,
      status: "processing",
    },
    {
      $set: set,
    },
    {
      returnDocument: "after",
    },
  );
};

export const markStripeEventFailed = async (providerEventId, error, processingToken = null) => {
  return BillingEvent.findOneAndUpdate(
    {
      provider: "stripe",
      providerEventId,
      processingToken,
      status: "processing",
    },
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        processingStartedAt: null,
        processingToken: null,
        failureReason: String(error?.message || error || "Unknown failure").slice(
          0,
          1000,
        ),
      },
    },
    {
      returnDocument: "after",
    },
  );
};

export const processStripeEventOnce = async ({
  event,
  requestId = "",
  handlers,
}) => {
  const reservation = await reserveStripeEvent(event, requestId);

  if (reservation.duplicate) {
    return {
      duplicate: true,
      handled: ["processed", "ignored"].includes(reservation.record?.status),
      inProgress: reservation.record?.status === "processing",
      record: reservation.record,
    };
  }

  const handler = handlers[event.type];

  if (!handler) {
    const record = await markStripeEventProcessed(event.id, {
      ignored: true,
      processingToken: reservation.record.processingToken,
    });

    return {
      duplicate: false,
      retried: reservation.retry,
      handled: false,
      ignored: true,
      record,
    };
  }

  try {
    const object = event.data.object;
    const resource = object.customer?.id || object.customer || object.metadata?.businessId || object.subscription || object.id;
    const execution = await withDistributedLease(`stripe-sync:${resource}`, () => handler(object));
    if (!execution.acquired) throw Object.assign(new Error('Billing reconciliation is already running'), {
      statusCode: 503, code: 'BILLING_RESOURCE_BUSY',
    });
    const result = execution.value;
    const record = await markStripeEventProcessed(event.id, {
      businessId: result?.business || result?.businessId || null,
      processingToken: reservation.record.processingToken,
    });

    if (!record) throw Object.assign(new Error('Billing event processing claim was replaced'), {
      code: 'BILLING_EVENT_CLAIM_LOST', statusCode: 503,
    });
    return {
      duplicate: false,
      retried: reservation.retry,
      handled: true,
      result,
      record,
    };
  } catch (error) {
    await markStripeEventFailed(event.id, error, reservation.record.processingToken);
    throw error;
  }
};
