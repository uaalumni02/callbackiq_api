import {
  ACCESS_LEVELS,
  getSubscriptionAccess,
} from "../../src/services/subscriptionAccess.service.js";

const now = new Date("2026-07-26T12:00:00.000Z");

describe("Subscription access policy", () => {
  test.each(["active"])("%s receives full access", (status) => {
    const result = getSubscriptionAccess(
      {
        status,
        isActive: true,
      },
      now,
    );

    expect(result.level).toBe(ACCESS_LEVELS.FULL);
    expect(result.providerActionsAllowed).toBe(true);
  });

  test("an unexpired trial receives full access", () => {
    const result = getSubscriptionAccess(
      {
        status: "trialing",
        isActive: true,
        trialEndsAt: "2026-07-27T12:00:00.000Z",
      },
      now,
    );

    expect(result.level).toBe(ACCESS_LEVELS.FULL);
  });

  test.each([
    "past_due",
    "unpaid",
    "expired",
    "paused",
    "none",
    "incomplete_expired",
  ])("%s cannot use provider actions", (status) => {
    const result = getSubscriptionAccess({ status }, now);
    expect(result.providerActionsAllowed).toBe(false);
    expect(result.automationAllowed).toBe(false);
  });


  test("cancel-at-period-end keeps full access until the paid period ends", () => {
    const result = getSubscriptionAccess(
      {
        status: "canceled",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: "2026-07-27T12:00:00.000Z",
      },
      now,
    );

    expect(result.level).toBe(ACCESS_LEVELS.FULL);
    expect(result.providerActionsAllowed).toBe(true);
  });

  test("an incomplete checkout is billing-only", () => {
    const result = getSubscriptionAccess({ status: "incomplete" }, now);
    expect(result.level).toBe(ACCESS_LEVELS.BILLING_ONLY);
  });
});
