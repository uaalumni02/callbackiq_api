import {
  getSubscriptionAccess,
} from "../../src/services/subscriptionAccess.service.js";

describe("subscription access for stale expired trials", () => {
  const now = new Date("2026-08-31T01:43:02.655Z");

  test("treats stale trialing state with a past trialEndsAt as expired/read-only", () => {
    const access = getSubscriptionAccess(
      {
        status: "trialing",
        isActive: true,
        trialEndsAt: new Date("2026-08-28T01:06:43.000Z"),
      },
      now,
    );

    expect(access).toMatchObject({
      level: "read_only",
      status: "expired",
      automationAllowed: false,
      providerActionsAllowed: false,
      reason: "inactive_expired",
    });
  });

  test("retains full access while the trial has not ended", () => {
    const access = getSubscriptionAccess(
      {
        status: "trialing",
        isActive: true,
        trialEndsAt: new Date("2026-09-10T01:06:43.000Z"),
      },
      now,
    );

    expect(access).toMatchObject({
      level: "full",
      status: "trialing",
      automationAllowed: true,
      providerActionsAllowed: true,
    });
  });

  test("expires access at the exact trial end instant", () => {
    const access = getSubscriptionAccess(
      {
        status: "trialing",
        isActive: true,
        trialEndsAt: new Date("2026-08-31T01:43:02.655Z"),
      },
      now,
    );

    expect(access.level).toBe("read_only");
    expect(access.status).toBe("expired");
    expect(access.automationAllowed).toBe(false);
    expect(access.providerActionsAllowed).toBe(false);
  });
});
