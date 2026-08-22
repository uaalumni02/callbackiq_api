jest.mock("../../src/voice/voicePhone.service.js", () => ({
  normalizePhoneToE164: jest.fn((value) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return "";
  }),
}));

import OwnerBrowserCallService, {
  OWNER_BROWSER_CALL_TYPE,
  STATUS_SIGNATURE_GRACE_SECONDS,
  TOKEN_TTL_SECONDS,
  buildFailureTwiml,
  buildStatusCallbackUrl,
  mapProspectStatus,
  requireBusinessCallerId,
  resolveSharedBrowserCallConfig,
  signOwnerBrowserCallSession,
  verifyOwnerBrowserCallSession,
} from "../../src/services/ownerBrowserCall.service.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const API_KEY_SID = `SK${"b".repeat(32)}`;
const TWIML_APP_SID = `AP${"c".repeat(32)}`;
const API_SECRET = ["owner", "browser", "test", "secret"].join("-");

const captureError = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected function to throw");
};

const setBrowserCallEnvironment = () => {
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    DEMO_TWILIO_API_KEY_SID: API_KEY_SID,
    DEMO_TWILIO_TWIML_APP_SID: TWIML_APP_SID,
    TWILIO_WEBHOOK_BASE_URL: "https://api.callbackiq.test/",
  });
  process.env.DEMO_TWILIO_API_KEY_SECRET = API_SECRET;
};

const clearBrowserCallEnvironment = () => {
  [
    "TWILIO_ACCOUNT_SID",
    "DEMO_TWILIO_API_KEY_SID",
    "TWILIO_API_KEY_SID",
    "TWILIO_API_KEY",
    "DEMO_TWILIO_API_KEY_SECRET",
    "TWILIO_API_KEY_SECRET",
    "TWILIO_API_SECRET",
    "DEMO_TWILIO_TWIML_APP_SID",
    "TWILIO_TWIML_APP_SID",
    "OWNER_BROWSER_CALL_STATUS_CALLBACK_URL",
    "DEMO_BROWSER_CALL_STATUS_CALLBACK_URL",
    "TWILIO_WEBHOOK_BASE_URL",
    "VOICE_HTTP_PUBLIC_URL",
  ].forEach((name) => delete process.env[name]);
};

const leadQuery = (value) => ({
  select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })),
});

const conversationQuery = (value) => ({
  sort: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })),
  })),
});

const businessQuery = (value) => ({
  select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })),
});

const makeModels = ({
  lead = {
    _id: "66c000000000000000000002",
    customerName: "Taylor Customer",
    phone: "+14045550111",
  },
  conversation = {
    _id: "conv-1",
    customerPhone: "+14045550111",
    customerName: "Conversation Customer",
  },
  business = {
    _id: "66c000000000000000000001",
    phone: "+14045550999",
    trackingNumber: { status: "active" },
  },
} = {}) => ({
  LeadModel: { findOne: jest.fn(() => leadQuery(lead)) },
  ConversationModel: {
    findOne: jest.fn(() => conversationQuery(conversation)),
  },
  BusinessModel: { findById: jest.fn(() => businessQuery(business)) },
});

const signedParams = ({
  businessId = "66c000000000000000000001",
  leadId = "66c000000000000000000002",
  attemptId = "attempt-123",
  expiresAt = Math.floor(NOW.getTime() / 1000) + TOKEN_TTL_SECONDS,
} = {}) => {
  const base = {
    callType: OWNER_BROWSER_CALL_TYPE,
    businessId,
    leadId,
    attemptId,
    expiresAt: String(expiresAt),
  };
  return {
    ...base,
    sessionSignature: signOwnerBrowserCallSession({
      apiKeySecret: API_SECRET,
      ...base,
    }),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  clearBrowserCallEnvironment();
  setBrowserCallEnvironment();
});

afterAll(() => {
  clearBrowserCallEnvironment();
});

describe("owner browser call target coverage", () => {
  test("shared config fails closed for each missing required Twilio value", () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    expect(captureError(() => resolveSharedBrowserCallConfig())).toMatchObject({
      code: "OWNER_BROWSER_CALL_ACCOUNT_NOT_CONFIGURED",
    });

    setBrowserCallEnvironment();
    delete process.env.DEMO_TWILIO_API_KEY_SID;
    expect(captureError(() => resolveSharedBrowserCallConfig())).toMatchObject({
      code: "OWNER_BROWSER_CALL_API_KEY_NOT_CONFIGURED",
    });

    setBrowserCallEnvironment();
    delete process.env.DEMO_TWILIO_API_KEY_SECRET;
    expect(captureError(() => resolveSharedBrowserCallConfig())).toMatchObject({
      code: "OWNER_BROWSER_CALL_API_SECRET_NOT_CONFIGURED",
    });

    setBrowserCallEnvironment();
    delete process.env.DEMO_TWILIO_TWIML_APP_SID;
    expect(captureError(() => resolveSharedBrowserCallConfig())).toMatchObject({
      code: "OWNER_BROWSER_CALL_APP_NOT_CONFIGURED",
    });
  });

  test("shared config accepts the standard non-demo credential aliases", () => {
    clearBrowserCallEnvironment();
    Object.assign(process.env, {
      TWILIO_ACCOUNT_SID: ACCOUNT_SID,
      TWILIO_API_KEY_SID: API_KEY_SID,
      TWILIO_TWIML_APP_SID: TWIML_APP_SID,
      VOICE_HTTP_PUBLIC_URL: "https://voice.callbackiq.test",
    });
    process.env.TWILIO_API_KEY_SECRET = API_SECRET;

    expect(resolveSharedBrowserCallConfig()).toEqual({
      accountSid: ACCOUNT_SID,
      apiKeySid: API_KEY_SID,
      apiKeySecret: API_SECRET,
      twimlAppSid: TWIML_APP_SID,
    });
  });

  test("business caller ID rejects invalid numbers and normalizes valid ones", () => {
    expect(captureError(() => requireBusinessCallerId("not-a-number"))).toMatchObject({
      code: "OWNER_BROWSER_CALL_CALLER_ID_NOT_CONFIGURED",
      statusCode: 409,
    });
    expect(requireBusinessCallerId("(404) 555-0999")).toBe("+14045550999");
  });

  test("status callback URL uses explicit callback first and appends signed parameters", () => {
    process.env.OWNER_BROWSER_CALL_STATUS_CALLBACK_URL =
      "https://hooks.callbackiq.test/browser-status?existing=1";
    const params = signedParams();
    const result = new URL(buildStatusCallbackUrl({ connectParams: params }));

    expect(result.origin).toBe("https://hooks.callbackiq.test");
    expect(result.searchParams.get("existing")).toBe("1");
    expect(result.searchParams.get("businessId")).toBe(params.businessId);
    expect(result.searchParams.get("sessionSignature")).toBe(params.sessionSignature);
  });

  test("status callback URL falls back to the shared webhook base", () => {
    delete process.env.OWNER_BROWSER_CALL_STATUS_CALLBACK_URL;
    delete process.env.DEMO_BROWSER_CALL_STATUS_CALLBACK_URL;

    expect(
      buildStatusCallbackUrl({ connectParams: signedParams() }),
    ).toContain("/api/demo-requests/browser-call-status?");
  });

  test("status callback configuration fails closed when no public URL exists", () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    delete process.env.VOICE_HTTP_PUBLIC_URL;

    expect(
      captureError(() => buildStatusCallbackUrl({ connectParams: signedParams() })),
    ).toMatchObject({ code: "OWNER_BROWSER_CALL_WEBHOOK_NOT_CONFIGURED" });
  });

  test("session verification rejects malformed, expired, stale-grace, and tampered parameters", () => {
    const valid = signedParams();
    expect(
      verifyOwnerBrowserCallSession({
        params: { ...valid, callType: "demo" },
        apiKeySecret: API_SECRET,
        now: NOW,
      }),
    ).toBe(false);

    expect(
      verifyOwnerBrowserCallSession({
        params: { ...valid, attemptId: "" },
        apiKeySecret: API_SECRET,
        now: NOW,
      }),
    ).toBe(false);

    const expiredAt = Math.floor(NOW.getTime() / 1000) - 1;
    const expired = signedParams({ expiresAt: expiredAt });
    expect(
      verifyOwnerBrowserCallSession({
        params: expired,
        apiKeySecret: API_SECRET,
        now: NOW,
      }),
    ).toBe(false);

    const staleAt =
      Math.floor(NOW.getTime() / 1000) - STATUS_SIGNATURE_GRACE_SECONDS - 1;
    const stale = signedParams({ expiresAt: staleAt });
    expect(
      verifyOwnerBrowserCallSession({
        params: stale,
        apiKeySecret: API_SECRET,
        allowExpired: true,
        now: NOW,
      }),
    ).toBe(false);

    expect(
      verifyOwnerBrowserCallSession({
        params: { ...valid, leadId: "66c000000000000000000099" },
        apiKeySecret: API_SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  test("failure TwiML is safe and self-contained", () => {
    const xml = buildFailureTwiml();
    expect(xml).toContain("could not connect");
    expect(xml).toContain("Hangup");
  });

  test("status mapping handles answered aliases and ignores unsupported states", () => {
    expect(mapProspectStatus("answered")).toBe("answered");
    expect(mapProspectStatus("IN-PROGRESS")).toBe("answered");
    expect(mapProspectStatus("completed")).toBe("answered");
    expect(mapProspectStatus("ringing")).toBe("");
  });

  test("createSession requires a business and returns null when the lead is gone", async () => {
    const models = makeModels();
    await expect(
      OwnerBrowserCallService.createSession({
        business: null,
        leadId: "66c000000000000000000002",
        ...models,
      }),
    ).rejects.toMatchObject({
      code: "OWNER_BROWSER_CALL_BUSINESS_MISSING",
      statusCode: 404,
    });

    const missingModels = makeModels({ lead: null });
    await expect(
      OwnerBrowserCallService.createSession({
        business: { _id: "66c000000000000000000001", phone: "+14045550999" },
        leadId: "66c000000000000000000002",
        ...missingModels,
      }),
    ).resolves.toBeNull();
  });

  test("createSession rejects a customer without a usable phone", async () => {
    const models = makeModels({
      lead: { _id: "66c000000000000000000002", customerName: "Taylor", phone: "" },
      conversation: { _id: "conv-1", customerPhone: "", customerName: "Taylor" },
    });

    await expect(
      OwnerBrowserCallService.createSession({
        business: { _id: "66c000000000000000000001", phone: "+14045550999" },
        leadId: "66c000000000000000000002",
        ...models,
      }),
    ).rejects.toMatchObject({ code: "OWNER_BROWSER_CALL_PHONE_MISSING" });
  });

  test("createSession issues a short-lived token using the server-selected destination", async () => {
    const models = makeModels({
      lead: {
        _id: "66c000000000000000000002",
        customerName: "",
        phone: "",
      },
      conversation: {
        _id: "conv-1",
        customerPhone: "+14045550111",
        customerName: "Conversation Customer",
      },
    });

    const result = await OwnerBrowserCallService.createSession({
      business: {
        _id: "66c000000000000000000001",
        phone: "+14045550999",
      },
      leadId: "66c000000000000000000002",
      actorId: "owner.1@example.com",
      now: NOW,
      ...models,
    });

    expect(result.lead).toEqual({
      id: "66c000000000000000000002",
      customerName: "Conversation Customer",
      phone: "+14045550111",
    });
    expect(result.session.token).toEqual(expect.any(String));
    expect(result.session.expiresIn).toBe(TOKEN_TTL_SECONDS);
    expect(result.session.callerId).toBe("+14045550999");
    expect(result.session.connectParams).toEqual(
      expect.objectContaining({
        callType: OWNER_BROWSER_CALL_TYPE,
        businessId: "66c000000000000000000001",
        leadId: "66c000000000000000000002",
        attemptId: expect.any(String),
        sessionSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  test("buildTwiml rejects an invalid session before database lookup", async () => {
    const models = makeModels();

    await expect(
      OwnerBrowserCallService.buildTwiml({
        params: { ...signedParams(), sessionSignature: "tampered" },
        ...models,
      }),
    ).rejects.toMatchObject({
      code: "OWNER_BROWSER_CALL_SESSION_INVALID",
      statusCode: 403,
    });

    expect(models.BusinessModel.findById).not.toHaveBeenCalled();
  });

  test("buildTwiml rejects missing business and missing customer phone", async () => {
    const missingBusiness = makeModels({ business: null });
    await expect(
      OwnerBrowserCallService.buildTwiml({
        params: signedParams(),
        ...missingBusiness,
      }),
    ).rejects.toMatchObject({ code: "OWNER_BROWSER_CALL_BUSINESS_MISSING" });

    const missingPhone = makeModels({
      lead: { _id: "66c000000000000000000002", phone: "", customerName: "" },
      conversation: null,
    });
    await expect(
      OwnerBrowserCallService.buildTwiml({
        params: signedParams(),
        ...missingPhone,
      }),
    ).rejects.toMatchObject({ code: "OWNER_BROWSER_CALL_PHONE_MISSING" });
  });

  test("buildTwiml dials the resolved customer from the business tracking number", async () => {
    const models = makeModels();
    const xml = await OwnerBrowserCallService.buildTwiml({
      params: signedParams(),
      ...models,
    });

    expect(xml).toContain("+14045550111");
    expect(xml).toContain("+14045550999");
    expect(xml).toContain("browser-call-status");
    expect(xml).toContain("attempt-123");
  });

  test("status webhook ignores invalid sessions, unsupported statuses, and missing businesses", async () => {
    const models = makeModels();
    const CallLogModel = { findOneAndUpdate: jest.fn() };

    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: { ...signedParams(), sessionSignature: "tampered" },
        payload: { CallSid: "CA1", CallStatus: "completed" },
        now: NOW,
        ...models,
        CallLogModel,
      }),
    ).resolves.toBeNull();

    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: signedParams(),
        payload: { CallSid: "CA1", CallStatus: "ringing" },
        now: NOW,
        ...models,
        CallLogModel,
      }),
    ).resolves.toBeNull();

    const missingBusiness = makeModels({ business: null });
    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: signedParams(),
        payload: { CallSid: "CA1", CallStatus: "completed" },
        now: NOW,
        ...missingBusiness,
        CallLogModel,
      }),
    ).resolves.toBeNull();

    expect(CallLogModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("status webhook ignores a lead that no longer has a valid phone", async () => {
    const models = makeModels({
      lead: { _id: "66c000000000000000000002", phone: "", customerName: "" },
      conversation: null,
    });
    const CallLogModel = { findOneAndUpdate: jest.fn() };

    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: signedParams(),
        payload: { CallSid: "CA1", CallStatus: "completed" },
        now: NOW,
        ...models,
        CallLogModel,
      }),
    ).resolves.toBeNull();
  });

  test("status webhook upserts completed calls with rounded duration", async () => {
    const models = makeModels();
    const saved = { _id: "call-log-1" };
    const CallLogModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(saved),
    };

    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: signedParams(),
        payload: {
          CallSid: "CA123",
          CallStatus: "completed",
          CallDuration: "42.4",
        },
        now: NOW,
        ...models,
        CallLogModel,
      }),
    ).resolves.toBe(saved);

    expect(CallLogModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        business: "66c000000000000000000001",
        providerCallId: "CA123",
      },
      {
        $set: expect.objectContaining({
          lead: "66c000000000000000000002",
          conversation: "conv-1",
          from: "+14045550999",
          to: "+14045550111",
          direction: "outbound",
          status: "answered",
          durationSeconds: 42,
        }),
      },
      expect.objectContaining({ upsert: true, runValidators: true }),
    );
  });

  test("status webhook retries duplicate-key races as a non-upsert update", async () => {
    const models = makeModels();
    const duplicate = Object.assign(new Error("duplicate"), { code: 11000 });
    const saved = { _id: "call-log-1" };
    const CallLogModel = {
      findOneAndUpdate: jest
        .fn()
        .mockRejectedValueOnce(duplicate)
        .mockResolvedValueOnce(saved),
    };

    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: signedParams(),
        payload: { CallSid: "CA123", CallStatus: "busy" },
        now: NOW,
        ...models,
        CallLogModel,
      }),
    ).resolves.toBe(saved);

    expect(CallLogModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(CallLogModel.findOneAndUpdate.mock.calls[1][2]).toEqual({
      new: true,
      runValidators: true,
    });
  });

  test("status webhook rethrows non-duplicate persistence failures", async () => {
    const models = makeModels();
    const CallLogModel = {
      findOneAndUpdate: jest.fn().mockRejectedValue(new Error("database unavailable")),
    };

    await expect(
      OwnerBrowserCallService.applyProspectStatus({
        params: signedParams(),
        payload: { CallSid: "CA123", CallStatus: "failed" },
        now: NOW,
        ...models,
        CallLogModel,
      }),
    ).rejects.toThrow("database unavailable");
  });
});
