import {
  OWNER_BROWSER_CALL_TYPE,
  buildOwnerProspectDialTwiml,
  mapProspectStatus,
  signOwnerBrowserCallSession,
  verifyOwnerBrowserCallSession,
} from "../../src/services/ownerBrowserCall.service.js";

describe("ownerBrowserCall.service security helpers", () => {
  const apiKeySecret = "test-secret";
  const base = {
    callType: OWNER_BROWSER_CALL_TYPE,
    businessId: "66c000000000000000000001",
    leadId: "66c000000000000000000002",
    attemptId: "attempt-123",
    expiresAt: "2000000000",
  };

  test("accepts an untampered signed owner call session", () => {
    const sessionSignature = signOwnerBrowserCallSession({
      apiKeySecret,
      ...base,
    });

    expect(
      verifyOwnerBrowserCallSession({
        params: { ...base, sessionSignature },
        apiKeySecret,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  test("rejects cross-tenant or cross-lead parameter tampering", () => {
    const sessionSignature = signOwnerBrowserCallSession({
      apiKeySecret,
      ...base,
    });

    expect(
      verifyOwnerBrowserCallSession({
        params: {
          ...base,
          businessId: "66c000000000000000000099",
          sessionSignature,
        },
        apiKeySecret,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toBe(false);

    expect(
      verifyOwnerBrowserCallSession({
        params: {
          ...base,
          leadId: "66c000000000000000000098",
          sessionSignature,
        },
        apiKeySecret,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test("rejects expired sessions for the TwiML call-start path", () => {
    const params = {
      ...base,
      expiresAt: "1700000000",
    };
    const sessionSignature = signOwnerBrowserCallSession({
      apiKeySecret,
      ...params,
    });

    expect(
      verifyOwnerBrowserCallSession({
        params: { ...params, sessionSignature },
        apiKeySecret,
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  test.each([
    ["in-progress", "answered"],
    ["completed", "answered"],
    ["busy", "busy"],
    ["no-answer", "no_answer"],
    ["failed", "failed"],
    ["canceled", "failed"],
    ["ringing", ""],
  ])("maps Twilio %s status to %s", (providerStatus, expected) => {
    expect(mapProspectStatus(providerStatus)).toBe(expected);
  });

  test("dials the server-selected customer from the business tracking number", () => {
    const xml = buildOwnerProspectDialTwiml({
      customerPhone: "+14045550111",
      callerId: "+14045550999",
      statusCallback:
        "https://example.com/api/demo-requests/browser-call-status?callType=owner_lead",
    });

    expect(xml).toContain("+14045550111");
    expect(xml).toContain("+14045550999");
    expect(xml).toContain("browser-call-status");
  });
});
