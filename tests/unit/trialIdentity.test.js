import {
  buildTrialIdentity,
  isDisposableTrialEmail,
  normalizeEmail,
  normalizePhone,
} from "../../src/helpers/billing/trial.js";

describe("trial identity hardening", () => {
  test("canonicalizes Gmail dot and plus aliases to one lifetime identity", () => {
    expect(normalizeEmail("U.ser+campaign@googlemail.com")).toBe(
      "user@gmail.com",
    );
    expect(normalizeEmail("user@gmail.com")).toBe("user@gmail.com");
  });

  test("does not remove aliases for non-Gmail providers", () => {
    expect(normalizeEmail("owner+atlanta@example.com")).toBe(
      "owner+atlanta@example.com",
    );
  });

  test("uses the forwarding phone instead of the CallBackIQ tracking number", () => {
    const identity = buildTrialIdentity(
      {
        email: "owner@example.com",
        forwardingPhone: "(404) 555-1212",
        phone: "+16785550000",
      },
      "owner-1",
    );

    expect(identity.phoneKey).toBe("+14045551212");
  });

  test("normalizes US phone numbers to E.164", () => {
    expect(normalizePhone("404-555-1212")).toBe("+14045551212");
  });

  test("blocks known disposable trial domains", () => {
    expect(isDisposableTrialEmail("owner@mailinator.com")).toBe(true);
    expect(isDisposableTrialEmail("owner@realcompany.com")).toBe(false);
  });
});
