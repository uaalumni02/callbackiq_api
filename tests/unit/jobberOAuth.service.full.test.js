import IntegrationConnection from "../../src/models/integrationConnection.js";
import {
  buildJobberAuthorizationUrl,
  disconnectJobber,
  exchangeJobberAuthorizationCode,
  refreshJobberAccessToken,
} from "../../src/services/integrations/jobberOAuth.service.js";
import { decryptSecret, encryptSecret } from "../../src/services/integrations/tokenEncryption.service.js";

jest.mock("../../src/models/integrationConnection.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
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
  status: "disconnected",
  accessTokenEncrypted: "encrypted:access-old",
  refreshTokenEncrypted: "encrypted:refresh-old",
  oauthStateHash: "",
  oauthStateExpiresAt: null,
  oauthCodeVerifierEncrypted: "encrypted:verifier",
  metadata: {},
  apiVersion: "2026-06-16",
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const setJobberEnv = () => {
  process.env.JOBBER_CLIENT_ID = "jobber-client";
  process.env.JOBBER_CLIENT_SECRET = "jobber-secret";
  process.env.JOBBER_REDIRECT_URI = "https://api.example.com/jobber/callback";
  process.env.JOBBER_API_VERSION = "2026-06-16";
  process.env.OAUTH_STATE_SECRET = "a-very-long-state-secret-for-tests";
};

const selectQuery = (value) => ({ select: jest.fn().mockResolvedValue(value) });

const buildState = async () => {
  IntegrationConnection.findOneAndUpdate.mockResolvedValue(makeConnection());
  const url = await buildJobberAuthorizationUrl("b1");
  return new URL(url).searchParams.get("state");
};

describe("jobberOAuth.service complete behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    process.env = { ...originalEnv };
    setJobberEnv();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test.each(["JOBBER_CLIENT_ID", "JOBBER_CLIENT_SECRET", "JOBBER_REDIRECT_URI"])("requires Jobber configuration field %s", async (field) => {
    delete process.env[field];
    await expect(buildJobberAuthorizationUrl("b1")).rejects.toMatchObject({
      statusCode: 503,
      code: "JOBBER_OAUTH_NOT_CONFIGURED",
    });
  });

  test("requires a sufficiently long OAuth state secret", async () => {
    process.env.OAUTH_STATE_SECRET = "short";
    await expect(buildJobberAuthorizationUrl("b1")).rejects.toMatchObject({ code: "JOBBER_OAUTH_NOT_CONFIGURED" });
  });

  test("builds and stores a PKCE Jobber authorization request", async () => {
    const urlString = await buildJobberAuthorizationUrl("b1");
    const url = new URL(urlString);
    expect(url.origin + url.pathname).toBe("https://api.getjobber.com/api/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("jobber-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/jobber/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toContain(".");
    expect(IntegrationConnection.findOneAndUpdate).toHaveBeenCalledWith(
      { business: "b1", provider: "jobber" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "disconnected",
          oauthStateHash: expect.any(String),
          oauthStateExpiresAt: new Date("2026-07-27T12:10:00.000Z"),
          oauthCodeVerifierEncrypted: expect.stringContaining("encrypted:"),
        }),
      }),
      { upsert: true, new: true },
    );
  });

  test.each(["", "missing.signature"])("rejects invalid state %s", async (state) => {
    await expect(exchangeJobberAuthorizationCode({ code: "code", state })).rejects.toThrow();
  });

  test("rejects a tampered state", async () => {
    const state = await buildState();
    const tampered = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`;
    await expect(exchangeJobberAuthorizationCode({ code: "code", state: tampered })).rejects.toThrow("verification failed");
  });

  test("rejects an expired signed state", async () => {
    const state = await buildState();
    jest.setSystemTime(new Date("2026-07-27T12:11:00.000Z"));
    await expect(exchangeJobberAuthorizationCode({ code: "code", state })).rejects.toThrow("expired");
  });

  test("rejects state not matching the active request", async () => {
    const state = await buildState();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection({ oauthStateHash: "wrong", oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z") })));
    await expect(exchangeJobberAuthorizationCode({ code: "code", state })).rejects.toThrow("does not match");
  });

  test("reports token endpoint errors", async () => {
    const state = await buildState();
    const pending = makeConnection({
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
      oauthCodeVerifierEncrypted: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthCodeVerifierEncrypted,
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch.mockResolvedValue(response({ ok: false, status: 400, payload: { error_description: "bad code" } }));
    await expect(exchangeJobberAuthorizationCode({ code: "bad", state })).rejects.toMatchObject({
      message: "bad code",
      statusCode: 400,
      providerPayload: { error_description: "bad code" },
    });
  });

  test("requires both access and refresh tokens", async () => {
    const state = await buildState();
    const pending = makeConnection({
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
      oauthCodeVerifierEncrypted: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthCodeVerifierEncrypted,
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch.mockResolvedValue(response({ payload: { access_token: "access" } }));
    await expect(exchangeJobberAuthorizationCode({ code: "code", state })).rejects.toThrow("required access and refresh tokens");
  });

  test("requires an API version before account lookup", async () => {
    const state = await buildState();
    const pending = makeConnection({
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
      oauthCodeVerifierEncrypted: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthCodeVerifierEncrypted,
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    delete process.env.JOBBER_API_VERSION;
    global.fetch.mockResolvedValueOnce(response({ payload: { access_token: "access", refresh_token: "refresh" } }));
    await expect(exchangeJobberAuthorizationCode({ code: "code", state })).rejects.toMatchObject({ statusCode: 503 });
  });

  test.each([
    [{ errors: [{ message: "account denied" }] }, "account denied"],
    [{ data: {} }, "did not return an account"],
  ])("rejects invalid account lookup payload %#", async (accountPayload, message) => {
    const state = await buildState();
    const pending = makeConnection({
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
      oauthCodeVerifierEncrypted: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthCodeVerifierEncrypted,
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch
      .mockResolvedValueOnce(response({ payload: { access_token: "access", refresh_token: "refresh" } }))
      .mockResolvedValueOnce(response({ payload: accountPayload }));
    await expect(exchangeJobberAuthorizationCode({ code: "code", state })).rejects.toThrow(message);
  });

  test("exchanges code, resolves account, and persists connection", async () => {
    const state = await buildState();
    const pending = makeConnection({
      metadata: { existing: true },
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
      oauthCodeVerifierEncrypted: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthCodeVerifierEncrypted,
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch
      .mockResolvedValueOnce(response({ payload: {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 1800,
        token_type: "Custom",
      } }))
      .mockResolvedValueOnce(response({ payload: { data: { account: { id: 123, name: "Peachtree Plumbing" } } } }));
    const result = await exchangeJobberAuthorizationCode({ code: "code", state });
    expect(result).toEqual({ businessId: "b1", connection: pending, account: { id: 123, name: "Peachtree Plumbing" } });
    expect(pending).toMatchObject({
      status: "connected",
      accessTokenEncrypted: "encrypted:access-new",
      refreshTokenEncrypted: "encrypted:refresh-new",
      tokenExpiresAt: new Date("2026-07-27T12:30:00.000Z"),
      providerAccountId: "123",
      apiVersion: "2026-06-16",
      metadata: { existing: true, accountName: "Peachtree Plumbing", tokenType: "Custom" },
      oauthStateHash: "",
      oauthStateExpiresAt: null,
      oauthCodeVerifierEncrypted: "",
      lastErrorAt: null,
      lastErrorMessage: "",
    });
    expect(pending.save).toHaveBeenCalled();
  });

  test("uses token defaults when optional fields are omitted", async () => {
    const state = await buildState();
    const pending = makeConnection({
      metadata: null,
      oauthStateHash: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthStateHash,
      oauthStateExpiresAt: new Date("2026-07-27T12:09:00Z"),
      oauthCodeVerifierEncrypted: IntegrationConnection.findOneAndUpdate.mock.calls[0][1].$set.oauthCodeVerifierEncrypted,
    });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(pending));
    global.fetch
      .mockResolvedValueOnce(response({ payload: { access_token: "access", refresh_token: "refresh" } }))
      .mockResolvedValueOnce(response({ payload: { data: { account: { id: "acct", name: "" } } } }));
    await exchangeJobberAuthorizationCode({ code: "code", state });
    expect(pending.tokenExpiresAt).toEqual(new Date("2026-07-27T13:00:00.000Z"));
    expect(pending.metadata).toEqual({ accountName: "", tokenType: "Bearer" });
  });

  test("loads refresh-token fields when the supplied document lacks them", async () => {
    const loaded = makeConnection();
    IntegrationConnection.findById.mockReturnValue(selectQuery(loaded));
    global.fetch.mockResolvedValue(response({ payload: { access_token: "fresh", expires_in: 60 } }));
    await expect(refreshJobberAccessToken({ _id: "conn1" })).resolves.toBe(loaded);
    expect(IntegrationConnection.findById).toHaveBeenCalledWith("conn1");
  });

  test("rejects refresh without a refresh token", async () => {
    IntegrationConnection.findById.mockReturnValue(selectQuery(makeConnection({ refreshTokenEncrypted: "" })));
    await expect(refreshJobberAccessToken({ _id: "conn1" })).rejects.toMatchObject({
      statusCode: 409,
      code: "JOBBER_REAUTHORIZATION_REQUIRED",
    });
  });

  test("refreshes and rotates Jobber tokens", async () => {
    const connection = makeConnection();
    global.fetch.mockResolvedValue(response({ payload: {
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 120,
    } }));
    await expect(refreshJobberAccessToken(connection)).resolves.toBe(connection);
    expect(connection).toMatchObject({
      accessTokenEncrypted: "encrypted:fresh-access",
      refreshTokenEncrypted: "encrypted:fresh-refresh",
      tokenExpiresAt: new Date("2026-07-27T12:02:00.000Z"),
      status: "connected",
      lastErrorAt: null,
      lastErrorMessage: "",
    });
  });

  test("keeps the old refresh token when Jobber does not rotate it", async () => {
    const connection = makeConnection();
    global.fetch.mockResolvedValue(response({ payload: { access_token: "fresh-access" } }));
    await refreshJobberAccessToken(connection);
    expect(connection.refreshTokenEncrypted).toBe("encrypted:refresh-old");
    expect(connection.tokenExpiresAt).toEqual(new Date("2026-07-27T13:00:00.000Z"));
  });

  test("marks refresh failures expired", async () => {
    const connection = makeConnection();
    global.fetch.mockResolvedValue(response({ ok: false, status: 500, rejectJson: true }));
    await expect(refreshJobberAccessToken(connection)).rejects.toBeTruthy();
    expect(connection.status).toBe("expired");
    expect(connection.lastErrorAt).toEqual(expect.any(Date));
    expect(connection.save).toHaveBeenCalled();
  });

  test("returns null when disconnecting an absent connection", async () => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(null));
    await expect(disconnectJobber("b1")).resolves.toBeNull();
  });

  test("disconnects connected Jobber and attempts remote revocation", async () => {
    const connection = makeConnection({ status: "connected" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ payload: { data: {} } }));
    await expect(disconnectJobber("b1")).resolves.toBe(connection);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.getjobber.com/api/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-old",
          "X-JOBBER-GRAPHQL-VERSION": "2026-06-16",
        }),
      }),
    );
    expect(connection).toMatchObject({
      status: "disconnected",
      accessTokenEncrypted: "",
      refreshTokenEncrypted: "",
      tokenExpiresAt: null,
      oauthStateHash: "",
      oauthStateExpiresAt: null,
      oauthCodeVerifierEncrypted: "",
    });
  });

  test("still clears local tokens when remote disconnect fails", async () => {
    const connection = makeConnection({ status: "connected" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockRejectedValue(new Error("network down"));
    await expect(disconnectJobber("b1")).resolves.toBe(connection);
    expect(connection.status).toBe("disconnected");
  });

  test("skips remote revocation for an already disconnected connection", async () => {
    const connection = makeConnection({ status: "disconnected" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    await disconnectJobber("b1");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
