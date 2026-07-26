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
  { ignored = false, businessId = null } = {},
) => {
  const set = {
    status: ignored ? "ignored" : "processed",
    processedAt: new Date(),
    failureReason: "",
    failedAt: null,
    processingStartedAt: null,
  };

  if (businessId) set.business = businessId;

  return BillingEvent.findOneAndUpdate(
    {
      provider: "stripe",
      providerEventId,
    },
    {
      $set: set,
    },
    {
      returnDocument: "after",
    },
  );
};

export const markStripeEventFailed = async (providerEventId, error) => {
  return BillingEvent.findOneAndUpdate(
    {
      provider: "stripe",
      providerEventId,
    },
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        processingStartedAt: null,
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
    const result = await handler(event.data.object);
    const record = await markStripeEventProcessed(event.id, {
      businessId: result?.business || result?.businessId || null,
    });

    return {
      duplicate: false,
      retried: reservation.retry,
      handled: true,
      result,
      record,
    };
  } catch (error) {
    await markStripeEventFailed(event.id, error);
    throw error;
  }
};
