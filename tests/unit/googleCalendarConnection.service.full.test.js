import IntegrationConnection from "../../src/models/integrationConnection.js";
import {
  buildGoogleAuthorizationUrl,
  disconnectGoogleCalendar,
  exchangeGoogleAuthorizationCode,
  getGoogleAccessToken,
  getGoogleConnection,
  googleApiRequest,
  listGoogleCalendars,
  selectGoogleCalendar,
} from "../../src/services/integrations/googleCalendarConnection.service.js";
import { decryptSecret, encryptSecret } from "../../src/services/integrations/tokenEncryption.service.js";

jest.mock("../../src/models/integrationConnection.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));
jest.mock("../../src/services/integrations/tokenEncryption.service.js", () => ({
  __esModule: true,
  encryptSecret: jest.fn((value) => `encrypted:${value}`),
  decryptSecret: jest.fn((value) => String(value).replace(/^encrypted:/, "")),
}));

const response = ({ ok = true, status = 200, payload = {}, rejectJson = false } = {}) => ({
  ok,
  status,
  json: rejectJson
    ? jest.fn().mockRejectedValue(new Error("invalid json"))
    : jest.fn().mockResolvedValue(payload),
});

const makeConnection = (overrides = {}) => ({
  _id: "conn1",
  business: "b1",
  provider: "google_calendar",
  status: "connected",
  accessTokenEncrypted: "encrypted:access-old",
  refreshTokenEncrypted: "encrypted:refresh-old",
  tokenExpiresAt: new Date("2026-07-27T14:00:00.000Z"),
  oauthStateHash: "",
  oauthStateExpiresAt: null,
  providerCalendarId: "calendar@example.com",
  scopes: [],
  metadata: {},
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const setGoogleEnv = () => {
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "google-client";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "google-secret";
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = "https://api.example.com/google/callback";
  process.env.OAUTH_STATE_SECRET = "a-very-long-state-secret-for-tests";
};

const selectQuery = (value) => ({ select: jest.fn().mockResolvedValue(value) });

const buildState = async () => {
  IntegrationConnection.findOneAndUpdate.mockResolvedValue(makeConnection());
  const url = await buildGoogleAuthorizationUrl("b1");
  return new URL(url).searchParams.get("state");
};

describe("googleCalendarConnection.service complete behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    process.env = { ...originalEnv };
    setGoogleEnv();
    global.fetch = jest.fn();
    IntegrationConnection.updateOne.mockResolvedValue({ acknowledged: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test.each([
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CALENDAR_CLIENT_SECRET",
    "GOOGLE_CALENDAR_REDIRECT_URI",
  ])("requires Google configuration field %s", async (field) => {
    delete process.env[field];
    await expect(buildGoogleAuthorizationUrl("b1")).rejects.toMatchObject({
      statusCode: 503,
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
    });
  });

  test("requires a sufficiently long OAuth state secret", async () => {
    process.env.OAUTH_STATE_SECRET = "short";
    await expect(buildGoogleAuthorizationUrl("b1")).rejects.toMatchObject({ code: "GOOGLE_OAUTH_NOT_CONFIGURED" });
  });

  test("builds and stores a signed Google authorization request", async () => {
    const urlString = await buildGoogleAuthorizationUrl("b1");
    const url = new URL(urlString);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("google-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/google/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
    expect(url.searchParams.get("state")).toContain(".");
    expect(IntegrationConnection.findOneAndUpdate).toHaveBeenCalledWith(
      { business: "b1", provider: "google_calendar" },
      expect.objectContaining({
        $set: expect.objectContaining({
          oauthStateHash: expect.any(String),
          oauthStateExpiresAt: new Date("2026-07-27T12:10:00.000Z"),
          status: "disconnected",
        }),
      }),
      { upsert: true, new: true },
    );
  });

  test.each(["", "missing.signature"])("rejects malformed or invalid state %s", async (state) => {
    await expect(exchangeGoogleAuthorizationCode({ code: "code", state })).rejects.toThrow();
  });

  test("rejects a tampered state signature", async () => {
    const state = await buildState();
    const tampered = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`;
    await expect(exchangeGoogleAuthorizationCode({ code: "code", state: tampered })).rejects.toThrow("signature verification failed");
  });

  test("rejects an expired signed state", async () => {
    const state = await buildState();
    jest.setSystemTime(new Date("2026-07-27T12:11:00.000Z"));
    await expect(exchangeGoogleAuthorizationCode({ code: "code", state })).rejects.toThrow("expired");
  });

  test("rejects state that does not match the pending connection", async () => {
    const state = await buildState();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection({ oauthStateHash: "wrong", oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z") })));
    await expect(exchangeGoogleAuthorizationCode({ code: "code", state })).rejects.toMatchObject({ statusCode: 400 });
  });

  test("reports token-exchange provider errors", async () => {
    const state = await buildState();
    const pending = makeConnection({
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch.mockResolvedValue(response({ ok: false, status: 400, payload: { error_description: "bad code" } }));
    await expect(exchangeGoogleAuthorizationCode({ code: "bad", state })).rejects.toMatchObject({
      message: "bad code",
      statusCode: 400,
      providerPayload: { error_description: "bad code" },
    });
  });

  test("exchanges code and persists tokens, scopes, and expiry", async () => {
    const state = await buildState();
    const pending = makeConnection({
      status: "disconnected",
      refreshTokenEncrypted: "encrypted:existing-refresh",
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch.mockResolvedValue(response({ payload: {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: "scope.one scope.two",
    } }));
    const result = await exchangeGoogleAuthorizationCode({ code: "code", state });
    expect(result).toEqual({ businessId: "b1", connection: pending });
    expect(pending).toMatchObject({
      accessTokenEncrypted: "encrypted:new-access",
      refreshTokenEncrypted: "encrypted:new-refresh",
      tokenExpiresAt: new Date("2026-07-27T13:00:00.000Z"),
      scopes: ["scope.one", "scope.two"],
      status: "connected",
      oauthStateHash: "",
      oauthStateExpiresAt: null,
      lastErrorAt: null,
      lastErrorMessage: "",
    });
    expect(pending.save).toHaveBeenCalled();
  });

  test("keeps an existing refresh token and uses default scopes when omitted", async () => {
    const state = await buildState();
    const pending = makeConnection({
      refreshTokenEncrypted: "encrypted:existing-refresh",
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch.mockResolvedValue(response({ payload: { access_token: "new-access" } }));
    await exchangeGoogleAuthorizationCode({ code: "code", state });
    expect(pending.refreshTokenEncrypted).toBe("encrypted:existing-refresh");
    expect(pending.tokenExpiresAt).toBeNull();
    expect(pending.scopes).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]));
  });

  test("getGoogleConnection optionally selects encrypted tokens", async () => {
    const query = { select: jest.fn().mockReturnValue("selected") };
    IntegrationConnection.findOne.mockReturnValue(query);
    expect(await getGoogleConnection("b1", false)).toBe(query);
    expect(query.select).not.toHaveBeenCalled();
    expect(await getGoogleConnection("b1", true)).toBe("selected");
    expect(query.select).toHaveBeenCalledWith("+accessTokenEncrypted +refreshTokenEncrypted");
  });

  test("rejects a missing or disconnected Google connection", async () => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(null));
    await expect(getGoogleAccessToken("b1")).rejects.toMatchObject({ statusCode: 409, code: "GOOGLE_NOT_CONNECTED" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection({ status: "disconnected" })));
    await expect(getGoogleAccessToken("b1")).rejects.toMatchObject({ code: "GOOGLE_NOT_CONNECTED" });
  });

  test("returns a usable encrypted access token without refreshing", async () => {
    const connection = makeConnection();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    await expect(getGoogleAccessToken("b1")).resolves.toEqual({ token: "access-old", connection });
    expect(decryptSecret).toHaveBeenCalledWith("encrypted:access-old");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("marks authorization expired when no refresh token exists", async () => {
    const connection = makeConnection({ accessTokenEncrypted: "", refreshTokenEncrypted: "", tokenExpiresAt: new Date("2026-07-27T11:00:00Z") });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    await expect(getGoogleAccessToken("b1")).rejects.toMatchObject({ code: "GOOGLE_AUTH_EXPIRED" });
    expect(connection.status).toBe("expired");
    expect(connection.lastErrorMessage).toContain("refresh token");
    expect(connection.save).toHaveBeenCalled();
  });

  test("refreshes an expired token", async () => {
    const connection = makeConnection({ tokenExpiresAt: new Date("2026-07-27T12:00:30Z") });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ payload: { access_token: "fresh", expires_in: 1800 } }));
    await expect(getGoogleAccessToken("b1")).resolves.toEqual({ token: "fresh", connection });
    expect(connection).toMatchObject({
      accessTokenEncrypted: "encrypted:fresh",
      tokenExpiresAt: new Date("2026-07-27T12:30:00.000Z"),
      status: "connected",
    });
  });

  test("records refresh failure on the connection", async () => {
    const connection = makeConnection({ tokenExpiresAt: new Date("2026-07-27T11:00:00Z") });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ ok: false, status: 500, payload: { error: { message: "Google down" } } }));
    await expect(getGoogleAccessToken("b1")).rejects.toMatchObject({ message: "Google down", statusCode: 502 });
    expect(connection.status).toBe("error");
    expect(connection.lastErrorMessage).toBe("Google down");
  });

  test("performs a successful Google API request with and without a body", async () => {
    const connection = makeConnection();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValueOnce(response({ payload: { items: [] } }));
    await expect(googleApiRequest({ businessId: "b1", path: "/calendars" })).resolves.toEqual({ items: [] });
    expect(global.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer access-old" },
      body: undefined,
    }));

    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValueOnce(response({ payload: { id: "event" } }));
    await googleApiRequest({ businessId: "b1", path: "/events", method: "POST", body: { summary: "Test" } });
    expect(global.fetch.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer access-old", "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "Test" }),
    }));
    expect(IntegrationConnection.updateOne).toHaveBeenCalledWith(
      { _id: "conn1" },
      { $set: expect.objectContaining({ status: "connected", lastErrorAt: null, lastErrorMessage: "" }) },
    );
  });

  test.each([[401, "expired"], [503, "error"]])("records API failure status %s", async (status, expectedConnectionStatus) => {
    const connection = makeConnection();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ ok: false, status, rejectJson: true }));
    await expect(googleApiRequest({ businessId: "b1", path: "/bad" })).rejects.toBeTruthy();
    expect(IntegrationConnection.updateOne).toHaveBeenCalledWith(
      { _id: "conn1" },
      { $set: expect.objectContaining({ status: expectedConnectionStatus, lastErrorAt: expect.any(Date) }) },
    );
  });

  test("maps calendar-list data", async () => {
    const connection = makeConnection();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ payload: { items: [{
      id: "cal1",
      summary: "Bookings",
      primary: 1,
      selected: 0,
      accessRole: "owner",
      timeZone: "America/New_York",
    }] } }));
    await expect(listGoogleCalendars("b1")).resolves.toEqual([{
      id: "cal1",
      summary: "Bookings",
      primary: true,
      selected: false,
      accessRole: "owner",
      timeZone: "America/New_York",
    }]);
  });

  test("returns an empty calendar list when Google omits items", async () => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection()));
    global.fetch.mockResolvedValue(response({ payload: {} }));
    await expect(listGoogleCalendars("b1")).resolves.toEqual([]);
  });

  test("validates and stores a selected writable calendar", async () => {
    await expect(selectGoogleCalendar({ businessId: "b1", calendarId: "  " })).rejects.toMatchObject({ statusCode: 400 });

    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection()));
    global.fetch.mockResolvedValueOnce(response({ payload: { items: [] } }));
    await expect(selectGoogleCalendar({ businessId: "b1", calendarId: "missing" })).rejects.toMatchObject({ statusCode: 404 });

    const updated = makeConnection({ providerCalendarId: "cal1" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection()));
    global.fetch.mockResolvedValueOnce(response({ payload: { items: [{ id: "cal1", summary: "Bookings" }] } }));
    IntegrationConnection.findOneAndUpdate.mockResolvedValue(updated);
    await expect(selectGoogleCalendar({ businessId: "b1", calendarId: " cal1 " })).resolves.toBe(updated);
    expect(IntegrationConnection.findOneAndUpdate).toHaveBeenCalledWith(
      { business: "b1", provider: "google_calendar" },
      { $set: expect.objectContaining({ providerCalendarId: "cal1", metadata: { selectedCalendarSummary: "Bookings" }, status: "connected" }) },
      { new: true },
    );
  });

  test("disconnects and clears local Google credentials", async () => {
    const disconnected = makeConnection({ status: "disconnected" });
    IntegrationConnection.findOneAndUpdate.mockResolvedValue(disconnected);
    await expect(disconnectGoogleCalendar("b1")).resolves.toBe(disconnected);
    expect(IntegrationConnection.findOneAndUpdate).toHaveBeenCalledWith(
      { business: "b1", provider: "google_calendar" },
      { $set: {
        status: "disconnected",
        accessTokenEncrypted: "",
        refreshTokenEncrypted: "",
        tokenExpiresAt: null,
        providerCalendarId: "",
        oauthStateHash: "",
        oauthStateExpiresAt: null,
      } },
      { new: true },
    );
  });
});
