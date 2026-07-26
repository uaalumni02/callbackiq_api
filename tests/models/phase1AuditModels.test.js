import BillingEvent from "../../src/models/billingEvent.js";
import SafetyEvent from "../../src/models/safetyEvent.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
  await BillingEvent.syncIndexes();
  await SafetyEvent.syncIndexes();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

describe("Phase 1 audit idempotency", () => {
  test("Stripe event ids are processed once", async () => {
    await BillingEvent.create({
      providerEventId: "evt_phase1_1",
      eventType: "invoice.paid",
    });

    await expect(
      BillingEvent.create({
        providerEventId: "evt_phase1_1",
        eventType: "invoice.paid",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test("a safety trigger is unique within one business", async () => {
    const business = "507f1f77bcf86cd799439011";
    const conversation = "507f191e810c19729de860ea";
    const inboundMessage = "507f191e810c19729de860eb";

    const record = {
      business,
      conversation,
      inboundMessage,
      providerMessageId: "SM_PHASE1_SAFETY",
      hazardType: "gas",
      triggeringMessageHash: "a".repeat(64),
    };

    await SafetyEvent.create(record);
    await expect(SafetyEvent.create(record)).rejects.toMatchObject({
      code: 11000,
    });
  });
});
