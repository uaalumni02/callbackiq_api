import fs from "node:fs";
import path from "node:path";

import {
  assertA2pSmsReady,
} from "../../src/services/twilioSmsService.js";
import {
  numberLifecycleRank,
  resolveNumberLifecycleStatus,
  shouldIgnoreNumberLifecycleEvent,
} from "../../src/services/a2pCustomerOnboarding.service.js";

describe("A2P security hardening regression", () => {
  test("central SMS gate blocks managed senders until Twilio registration succeeds", () => {
    let pendingError = null;
    try {
      assertA2pSmsReady({
        messagingCompliance: {
          a2pStatus: "pending",
          smsReady: false,
        },
      });
    } catch (error) {
      pendingError = error;
    }

    expect(pendingError).toMatchObject({
      code: "A2P_SMS_NOT_READY",
      statusCode: 409,
    });

    expect(() =>
      assertA2pSmsReady({
        messagingCompliance: {
          a2pStatus: "failed",
          smsReady: false,
        },
      }),
    ).toThrow();

    expect(() =>
      assertA2pSmsReady({
        messagingCompliance: {
          a2pStatus: "registered",
          smsReady: true,
        },
      }),
    ).not.toThrow();
  });

  test("legacy/unmanaged senders remain compatible until they enter automated A2P", () => {
    expect(() => assertA2pSmsReady({})).not.toThrow();
    expect(() =>
      assertA2pSmsReady({
        messagingCompliance: {
          a2pStatus: "unconfigured",
          smsReady: false,
        },
      }),
    ).not.toThrow();
  });

  test("number deregistration events resolve to fail-closed lifecycle states", () => {
    expect(
      resolveNumberLifecycleStatus({
        eventType:
          "com.twilio.messaging.compliance.number-deregistration.pending",
      }),
    ).toBe("PENDING_DEREGISTRATION");

    expect(
      resolveNumberLifecycleStatus({
        eventType:
          "com.twilio.messaging.compliance.number-deregistration.successful",
      }),
    ).toBe("DEREGISTERED");

    expect(
      resolveNumberLifecycleStatus({
        eventType:
          "com.twilio.messaging.compliance.number-deregistration.failed",
      }),
    ).toBe("DEREGISTRATION_FAILED");
  });

  test("duplicate, stale, and same-time lower-priority number events are ignored", () => {
    const registeredRank = numberLifecycleRank("REGISTERED");
    const pendingRank = numberLifecycleRank("PENDING_REGISTRATION");
    const deregPendingRank = numberLifecycleRank("PENDING_DEREGISTRATION");

    expect(deregPendingRank).toBeGreaterThan(registeredRank);

    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventId: "EZ-1",
        lastEventAt: "2026-08-14T17:05:00.000Z",
        lastEventRank: registeredRank,
        eventId: "EZ-1",
        eventAt: "2026-08-14T17:05:00.000Z",
        eventRank: registeredRank,
      }),
    ).toBe("duplicate");

    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventId: "EZ-2",
        lastEventAt: "2026-08-14T17:05:00.000Z",
        lastEventRank: registeredRank,
        eventId: "EZ-older",
        eventAt: "2026-08-14T17:04:59.000Z",
        eventRank: pendingRank,
      }),
    ).toBe("stale");

    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventId: "EZ-2",
        lastEventAt: "2026-08-14T17:05:00.000Z",
        lastEventRank: registeredRank,
        eventId: "EZ-same-time",
        eventAt: "2026-08-14T17:05:00.000Z",
        eventRank: pendingRank,
      }),
    ).toBe("stale");

    expect(
      shouldIgnoreNumberLifecycleEvent({
        lastEventId: "EZ-2",
        lastEventAt: "2026-08-14T17:05:00.000Z",
        lastEventRank: registeredRank,
        eventId: "EZ-newer",
        eventAt: "2026-08-14T17:06:00.000Z",
        eventRank: pendingRank,
      }),
    ).toBe("");
  });

  test("tracking-number provisioning is lease-protected and compensates orphan purchases", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/services/trackingNumberProvisioning.service.js",
      ),
      "utf8",
    );

    expect(source).toContain("acquireOperationLease");
    expect(source).toContain("TRACKING_NUMBER_PROVISIONING_IN_PROGRESS");
    expect(source).toContain("purchasedProviderSid");
    expect(source).toContain("incomingPhoneNumbers(purchasedProviderSid).remove()");
    expect(source).toContain('a2pStatus: "pending"');
    expect(source).toContain("TRACKING_NUMBER_PROVISIONING_WAIT_MS");
  });

  test("OTP retries use atomic cooldown/window reservations", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/services/a2pCustomerOnboarding.service.js",
      ),
      "utf8",
    );

    expect(source).toContain("A2P_OTP_RETRY_COOLDOWN_MS");
    expect(source).toContain("A2P_OTP_RETRY_MAX_PER_WINDOW");
    expect(source).toContain("A2P_OTP_RETRY_COOLDOWN");
    expect(source).toContain("findOneAndUpdate");
    expect(source).toContain("otpRetryCount");
  });

  test("event receiver preserves Twilio event id and timestamp", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/controllers/a2pEvents.controller.js"),
      "utf8",
    );

    expect(source).toContain("eventId:");
    expect(source).toContain("eventAt:");
    expect(source).toContain("event.data?.id");
    expect(source).toContain("event.data?.timestamp");
  });

  test("customer A2P controller returns sanitized provider failures", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/controllers/a2pCustomerOnboarding.controller.js",
      ),
      "utf8",
    );

    expect(source).toContain(
      "Unable to complete messaging registration. Please try again or contact support.",
    );
    expect(source).toContain("SAFE_APP_MESSAGES");
    expect(source).toContain("SAFE_VALIDATION_MESSAGES");
    expect(source).toContain("Object.prototype.hasOwnProperty.call");
    expect(source).not.toContain("/required|valid|select|unsupported|already has|must use|cannot be changed/i");
    expect(source).toContain('res.set("Retry-After"');

    const serviceSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/services/a2pCustomerOnboarding.service.js",
      ),
      "utf8",
    );
    expect(serviceSource).not.toContain("lastError: row.lastError");
    expect(serviceSource).toContain(
      "Messaging registration needs attention. Review your details and try again, or contact support.",
    );
    const linkSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/services/a2pMessagingRegistration.service.js",
      ),
      "utf8",
    );
    expect(linkSource).toContain("const message =");
    expect(linkSource).toContain("error?.message");
    expect(linkSource).toContain("sanitizePublicA2pError");
    expect(linkSource).toContain(
      '"messagingCompliance.lastError": sanitizePublicA2pError(state.lastError)',
    );
    expect(linkSource).toContain(
      "A2P_LINK_FAILED: Unable to link the tracking number to messaging registration.",
    );
  });
});
