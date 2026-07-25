import WebhookEvent from "../../models/webhookEvent.js";

const isDuplicateKeyError = (error) => {
  return error?.code === 11000;
};

export const claimTwilioWebhookEvent = async ({
  businessId,
  eventType,
  eventKey,
  providerEventId,
  requestMetadata = {},
}) => {
  try {
    const event = await WebhookEvent.create({
      business: businessId,
      provider: "twilio",
      eventType,
      eventKey,
      providerEventId,
      status: "processing",
      requestMetadata,
      firstReceivedAt: new Date(),
      lastReceivedAt: new Date(),
    });

    return {
      claimed: true,
      duplicate: false,
      event,
    };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const event = await WebhookEvent.findOneAndUpdate(
      {
        business: businessId,
        provider: "twilio",
        eventType,
        eventKey,
      },
      {
        $inc: {
          duplicateCount: 1,
        },
        $set: {
          lastReceivedAt: new Date(),
        },
      },
      {
        new: true,
      },
    );

    return {
      claimed: false,
      duplicate: true,
      event,
    };
  }
};

export const completeTwilioWebhookEvent = async (
  eventId,
  {
    statusCode = 200,
    contentType = "text/xml",
    responseBody = "",
  } = {},
) => {
  if (!eventId) {
    return null;
  }

  return WebhookEvent.findByIdAndUpdate(
    eventId,
    {
      status: "completed",
      completedAt: new Date(),
      failedAt: null,
      failureReason: "",
      responseStatusCode: statusCode,
      responseContentType: contentType,
      responseBody,
      lastReceivedAt: new Date(),
    },
    {
      new: true,
    },
  );
};

export const failTwilioWebhookEvent = async (
  eventId,
  error,
  {
    statusCode = 200,
    contentType = "text/xml",
    responseBody = "",
  } = {},
) => {
  if (!eventId) {
    return null;
  }

  const failureReason =
    error instanceof Error ? error.message : String(error || "Unknown error");

  return WebhookEvent.findByIdAndUpdate(
    eventId,
    {
      status: "failed",
      failedAt: new Date(),
      failureReason,
      responseStatusCode: statusCode,
      responseContentType: contentType,
      responseBody,
      lastReceivedAt: new Date(),
    },
    {
      new: true,
    },
  );
};
