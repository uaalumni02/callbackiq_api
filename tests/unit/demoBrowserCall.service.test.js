import DemoBrowserCallService, {
  activityIsRecentlyActive,
  buildProspectDialTwiml,
  buildStatusCallbackUrl,
  normalizeDemoPhoneToE164,
  resolveBrowserCallConfig,
} from "../../src/services/demoBrowserCall.service.js";

describe("DemoBrowserCallService helpers", () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  const configure = () => {
    process.env.TWILIO_ACCOUNT_SID = "AC11111111111111111111111111111111";
    process.env.DEMO_TWILIO_API_KEY_SID = "SK11111111111111111111111111111111";
    process.env.DEMO_TWILIO_API_KEY_SECRET = "test-secret";
    process.env.DEMO_TWILIO_TWIML_APP_SID = "AP11111111111111111111111111111111";
    process.env.DEMO_OUTBOUND_CALLER_ID = "678-576-8258";
  };

  test("normalizes US demo phone numbers without changing stored display values", () => {
    expect(normalizeDemoPhoneToE164("(404) 555-1111")).toBe("+14045551111");
    expect(normalizeDemoPhoneToE164("+16785768258")).toBe("+16785768258");
    expect(normalizeDemoPhoneToE164("not-a-phone")).toBe("");
  });

  test("uses the configured CallBackIQ caller ID and browser Voice credentials", () => {
    configure();

    expect(resolveBrowserCallConfig()).toEqual({
      accountSid: "AC11111111111111111111111111111111",
      apiKeySid: "SK11111111111111111111111111111111",
      apiKeySecret: "test-secret",
      twimlAppSid: "AP11111111111111111111111111111111",
      callerId: "+16785768258",
    });
  });

  test("builds direct prospect TwiML with no recording", () => {
    const xml = buildProspectDialTwiml({
      prospectPhone: "+14045551111",
      callerId: "+16785768258",
      statusCallback:
        "https://api.example.com/api/demo-requests/browser-call-status?demoRequestId=demo&attemptId=attempt",
    });

    expect(xml).toContain('callerId="+16785768258"');
    expect(xml).toContain("+14045551111");
    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('statusCallbackEvent="initiated ringing answered completed"');
    expect(xml.toLowerCase()).not.toContain("record=");
  });

  test("builds the child-call status callback URL", () => {
    process.env.DEMO_BROWSER_CALL_STATUS_CALLBACK_URL =
      "https://api.example.com/api/demo-requests/browser-call-status";

    expect(
      buildStatusCallbackUrl({
        demoId: "507f1f77bcf86cd799439011",
        attemptId: "attempt-1",
      }),
    ).toBe(
      "https://api.example.com/api/demo-requests/browser-call-status?demoRequestId=507f1f77bcf86cd799439011&attemptId=attempt-1",
    );
  });

  test("creates a call audit entry without changing demo pipeline fields", async () => {
    configure();
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.example.com";

    const demo = {
      _id: "507f1f77bcf86cd799439011",
      fullName: "John Smith",
      phone: "(404) 555-1111",
      phoneE164: "+14045551111",
      status: "scheduled",
      contactedAt: null,
      outreachActivities: [],
    };
    const select = jest.fn().mockResolvedValue(demo);
    const findByIdAndUpdate = jest.fn().mockResolvedValue({
      ...demo,
      lastOutreachChannel: "phone",
    });
    const DemoRequestModel = {
      findById: jest.fn(() => ({ select })),
      findByIdAndUpdate,
    };

    const result = await DemoBrowserCallService.createSession({
      DemoRequestModel,
      demoId: demo._id,
      actorId: "admin-1",
      actorEmail: "admin@callbackiq.com",
      now: new Date("2026-08-10T22:30:00.000Z"),
    });

    const update = findByIdAndUpdate.mock.calls[0][1];
    expect(update.$push.outreachActivities.type).toBe("call_initiated");
    expect(update.$set.lastOutreachChannel).toBe("phone");
    expect(update.$set.status).toBeUndefined();
    expect(update.$set.contactedAt).toBeUndefined();
    expect(result.session.callerId).toBe("+16785768258");
    expect(result.session.connectParams.demoRequestId).toBe(demo._id);
  });

  test("blocks accidental double-click sessions but allows terminal calls", () => {
    const now = new Date("2026-08-10T22:30:00.000Z");
    expect(
      activityIsRecentlyActive(
        {
          channel: "phone",
          callAttemptId: "attempt-1",
          at: new Date("2026-08-10T22:29:50.000Z"),
          clientCallStatus: "connecting",
          prospectCallStatus: "",
        },
        now,
      ),
    ).toBe(true);

    expect(
      activityIsRecentlyActive(
        {
          channel: "phone",
          callAttemptId: "attempt-1",
          at: new Date("2026-08-10T22:29:50.000Z"),
          clientCallStatus: "disconnected",
          prospectCallStatus: "completed",
        },
        now,
      ),
    ).toBe(false);
  });
});
