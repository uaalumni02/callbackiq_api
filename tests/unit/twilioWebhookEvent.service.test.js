
import mongoose from "mongoose";

import WebhookEvent from "../../src/models/webhookEvent.js";
import {
  claimTwilioWebhookEvent,
  completeTwilioWebhookEvent,
  failTwilioWebhookEvent,
} from "../../src/services/webhooks/twilioWebhookEvent.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
  await WebhookEvent.init();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const buildClaim = (overrides = {}) => ({
  businessId: new mongoose.Types.ObjectId(),
  eventType: "inbound_sms",
  eventKey: "inbound_sms:SM_TEST_123",
  providerEventId: "SM_TEST_123",
  requestMetadata: {
    from: "4045551111",
    to: "4045552222",
  },
  ...overrides,
});

describe("twilioWebhookEvent service", () => {
  test("claims a new webhook event", async () => {
    const claim = await claimTwilioWebhookEvent(buildClaim());

    expect(claim.claimed).toBe(true);
    expect(claim.duplicate).toBe(false);
    expect(claim.event.status).toBe("processing");
    expect(claim.event.attemptCount).toBe(1);
    expect(claim.event.duplicateCount).toBe(0);
  });

  test("returns the existing event for a duplicate claim", async () => {
    const payload = buildClaim();

    const first = await claimTwilioWebhookEvent(payload);
    const second = await claimTwilioWebhookEvent(payload);

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(String(second.event._id)).toBe(String(first.event._id));
    expect(second.event.duplicateCount).toBe(1);

    expect(await WebhookEvent.countDocuments()).toBe(1);
  });

  test("settles concurrent claims with one winner", async () => {
    const payload = buildClaim();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimTwilioWebhookEvent(payload),
      ),
    );

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(4);
    expect(await WebhookEvent.countDocuments()).toBe(1);

    const stored = await WebhookEvent.findOne({
      eventKey: payload.eventKey,
    });

    expect(stored.duplicateCount).toBe(4);
  });

  test("stores the completed webhook response for retries", async () => {
    const claim = await claimTwilioWebhookEvent(buildClaim());

    const completed = await completeTwilioWebhookEvent(claim.event._id, {
      statusCode: 200,
      contentType: "text/xml",
      responseBody: "<Response></Response>",
    });

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
    expect(completed.responseStatusCode).toBe(200);
    expect(completed.responseContentType).toBe("text/xml");
    expect(completed.responseBody).toBe("<Response></Response>");
    expect(completed.failureReason).toBe("");
  });

  test("records a failed webhook without deleting its claim", async () => {
    const claim = await claimTwilioWebhookEvent(buildClaim());

    const failed = await failTwilioWebhookEvent(
      claim.event._id,
      new Error("AI provider failed"),
      {
        statusCode: 200,
        contentType: "text/xml",
        responseBody: "<Response></Response>",
      },
    );

    expect(failed.status).toBe("failed");
    expect(failed.failedAt).toBeTruthy();
    expect(failed.failureReason).toBe("AI provider failed");
    expect(failed.responseStatusCode).toBe(200);
    expect(await WebhookEvent.countDocuments()).toBe(1);
  });
});
