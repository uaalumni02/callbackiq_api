import BillingAnomaly from "../../src/models/billingAnomaly.js";
import { recordBillingAnomaly } from "../../src/services/subscriptionIntegrity.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

describe("Billing anomaly persistence regression", () => {
  let consoleError;

  beforeAll(async () => {
    await connectTestDB();
    await BillingAnomaly.init();
  }, 60_000);

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleError.mockRestore();
    await clearTestDB();
  });

  afterAll(async () => {
    await closeTestDB();
  });

  test("upserts one anomaly and increments occurrences without conflicting update operators", async () => {
    const payload = {
      businessId: null,
      type: "duplicate_subscription",
      severity: "critical",
      stripeCustomerId: "cus_regression",
      canonicalSubscriptionId: "sub_canonical",
      observedSubscriptionId: "sub_observed",
      source: "regression_test",
      dedupeKey: "billing-anomaly-regression:1",
      details: { reason: "same anomaly twice" },
    };

    const first = await recordBillingAnomaly(payload);
    const second = await recordBillingAnomaly(payload);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const rows = await BillingAnomaly.find({
      dedupeKey: payload.dedupeKey,
    }).lean();

    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(2);
    expect(rows[0].status).toBe("open");
    expect(rows[0].firstSeenAt).toBeTruthy();
    expect(rows[0].lastSeenAt).toBeTruthy();
  });
});
