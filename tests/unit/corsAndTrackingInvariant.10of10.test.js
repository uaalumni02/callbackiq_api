import { expressCorsOptions } from "../../src/config/cors.js";
import {
  isTrackingNumberStateInconsistent,
} from "../../src/services/trackingNumberProvisioning.service.js";

describe("10/10 hardening contracts", () => {
  test("CORS permits browser appointment idempotency keys", () => {
    expect(expressCorsOptions.allowedHeaders).toContain("Idempotency-Key");
  });

  test("tracking-number invariant catches a stored phone with unassigned lifecycle", () => {
    expect(
      isTrackingNumberStateInconsistent({
        phone: "+14709052202",
        trackingNumber: { status: "unassigned", providerSid: "" },
      }),
    ).toBe(true);
  });

  test("tracking-number invariant catches missing provider SID", () => {
    expect(
      isTrackingNumberStateInconsistent({
        phone: "+14709052202",
        trackingNumber: { status: "active", providerSid: "" },
      }),
    ).toBe(true);
  });

  test("healthy active tracking number is not inconsistent", () => {
    expect(
      isTrackingNumberStateInconsistent({
        phone: "+14709052202",
        trackingNumber: {
          status: "active",
          providerSid: "PN98cc01855068e7332942483c39413201",
        },
      }),
    ).toBe(false);
  });
});
