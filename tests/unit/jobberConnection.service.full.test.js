import IntegrationConnection from "../../src/models/integrationConnection.js";
import {
  assertNoJobberUserErrors,
  getJobberConnection,
  jobberGraphqlRequest,
} from "../../src/services/integrations/jobberConnection.service.js";
import { decryptSecret } from "../../src/services/integrations/tokenEncryption.service.js";
import { refreshJobberAccessToken } from "../../src/services/integrations/jobberOAuth.service.js";

jest.mock("../../src/models/integrationConnection.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));
jest.mock("../../src/services/integrations/tokenEncryption.service.js", () => ({
  __esModule: true,
  decryptSecret: jest.fn((value) => String(value).replace(/^encrypted:/, "")),
}));
jest.mock("../../src/services/integrations/jobberOAuth.service.js", () => ({
  __esModule: true,
  refreshJobberAccessToken: jest.fn(),
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
  status: "connected",
  accessTokenEncrypted: "encrypted:access",
  refreshTokenEncrypted: "encrypted:refresh",
  tokenExpiresAt: new Date("2026-07-27T14:00:00.000Z"),
  apiVersion: "2026-06-16",
  ...overrides,
});

const selectQuery = (value) => ({ select: jest.fn().mockResolvedValue(value) });

describe("jobberConnection.service complete behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    process.env = { ...originalEnv, JOBBER_API_VERSION: "2026-06-16" };
    global.fetch = jest.fn();
    IntegrationConnection.updateOne.mockResolvedValue({ acknowledged: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test("gets a connection with and without selected secrets", async () => {
    const query = { select: jest.fn().mockReturnValue("with-secrets") };
    IntegrationConnection.findOne.mockReturnValue(query);
    expect(await getJobberConnection("b1", false)).toBe(query);
    expect(query.select).not.toHaveBeenCalled();
    expect(await getJobberConnection("b1", true)).toBe("with-secrets");
    expect(query.select).toHaveBeenCalledWith("+accessTokenEncrypted +refreshTokenEncrypted");
  });

  test.each([null, { status: "disconnected" }])("rejects an unavailable Jobber connection %#", async (connection) => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).rejects.toMatchObject({
      statusCode: 409,
      code: "JOBBER_NOT_CONNECTED",
    });
  });

  test.each([
    makeConnection({ accessTokenEncrypted: "" }),
    makeConnection({ tokenExpiresAt: null }),
    makeConnection({ tokenExpiresAt: new Date("2026-07-27T12:01:00Z") }),
  ])("refreshes an unusable connection %#", async (connection) => {
    const refreshed = makeConnection({ accessTokenEncrypted: "encrypted:fresh" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    refreshJobberAccessToken.mockResolvedValue(refreshed);
    global.fetch.mockResolvedValue(response({ payload: { data: { ok: true } } }));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).resolves.toEqual({ ok: true });
    expect(refreshJobberAccessToken).toHaveBeenCalledWith(connection);
    expect(decryptSecret).toHaveBeenCalledWith("encrypted:fresh");
  });

  test("does not refresh a valid connection", async () => {
    const connection = makeConnection();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ payload: { data: { ok: true } } }));
    await jobberGraphqlRequest({ businessId: "b1", query: "query Test" });
    expect(refreshJobberAccessToken).not.toHaveBeenCalled();
  });

  test("requires an API version", async () => {
    const connection = makeConnection({ apiVersion: "" });
    delete process.env.JOBBER_API_VERSION;
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).rejects.toMatchObject({ statusCode: 503 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("executes a successful GraphQL request with default variables", async () => {
    const connection = makeConnection();
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ payload: { data: { account: { id: "a1" } } } }));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Account" })).resolves.toEqual({ account: { id: "a1" } });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.getjobber.com/api/graphql",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer access",
          "Content-Type": "application/json",
          "X-JOBBER-GRAPHQL-VERSION": "2026-06-16",
        },
        body: JSON.stringify({ query: "query Account", variables: {} }),
      },
    );
    expect(IntegrationConnection.updateOne).toHaveBeenCalledWith(
      { _id: "conn1" },
      { $set: expect.objectContaining({ status: "connected", lastErrorAt: null, lastErrorMessage: "" }) },
    );
  });

  test("passes explicit variables", async () => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection()));
    global.fetch.mockResolvedValue(response({ payload: { data: { result: true } } }));
    await jobberGraphqlRequest({ businessId: "b1", query: "mutation X", variables: { id: "1" } });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ query: "mutation X", variables: { id: "1" } });
  });

  test("retries once after a 401 when a refresh token exists", async () => {
    const connection = makeConnection();
    const refreshed = makeConnection({ accessTokenEncrypted: "encrypted:fresh" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    refreshJobberAccessToken.mockResolvedValue(refreshed);
    global.fetch
      .mockResolvedValueOnce(response({ ok: false, status: 401, payload: { error: "expired" } }))
      .mockResolvedValueOnce(response({ payload: { data: { retried: true } } }));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).resolves.toEqual({ retried: true });
    expect(refreshJobberAccessToken).toHaveBeenCalledWith(connection);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("does not retry a 401 without a refresh token and records expired status", async () => {
    const connection = makeConnection({ refreshTokenEncrypted: "" });
    IntegrationConnection.findOne.mockReturnValue(selectQuery(connection));
    global.fetch.mockResolvedValue(response({ ok: false, status: 401, payload: { errors: [{ message: "Unauthorized" }] } }));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).rejects.toMatchObject({
      message: "Unauthorized",
      statusCode: 400,
      providerPayload: { errors: [{ message: "Unauthorized" }] },
    });
    expect(refreshJobberAccessToken).not.toHaveBeenCalled();
    expect(IntegrationConnection.updateOne).toHaveBeenCalledWith(
      { _id: "conn1" },
      { $set: expect.objectContaining({ status: "expired", lastErrorMessage: "Unauthorized" }) },
    );
  });

  test.each([
    [500, {}, 502, "Jobber request failed with status 500", "error"],
    [400, { errors: [{ message: "Bad input" }, { message: "Missing field" }] }, 400, "Bad input; Missing field", "error"],
  ])("normalizes failed response %s", async (status, payload, errorStatus, message, connectionStatus) => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection()));
    global.fetch.mockResolvedValue(response({ ok: false, status, payload }));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).rejects.toMatchObject({
      statusCode: errorStatus,
      message,
      providerPayload: payload,
    });
    expect(IntegrationConnection.updateOne).toHaveBeenCalledWith(
      { _id: "conn1" },
      { $set: expect.objectContaining({ status: connectionStatus, lastErrorMessage: message }) },
    );
  });

  test("handles invalid JSON on failure", async () => {
    IntegrationConnection.findOne.mockReturnValue(selectQuery(makeConnection()));
    global.fetch.mockResolvedValue(response({ ok: false, status: 503, rejectJson: true }));
    await expect(jobberGraphqlRequest({ businessId: "b1", query: "query Test" })).rejects.toMatchObject({
      statusCode: 502,
      message: "Jobber request failed with status 503",
    });
  });

  test("assertNoJobberUserErrors accepts missing or empty errors", () => {
    expect(() => assertNoJobberUserErrors(undefined, "create")).not.toThrow();
    expect(() => assertNoJobberUserErrors({ userErrors: [] }, "create")).not.toThrow();
  });

  test("assertNoJobberUserErrors combines messages and preserves metadata", () => {
    const result = {
      userErrors: [
        { message: "Client invalid" },
        { errorType: "VISIT_CONFLICT" },
        {},
      ],
    };
    expect(() => assertNoJobberUserErrors(result, "createAppointment")).toThrow("Client invalid; VISIT_CONFLICT; Jobber mutation failed");
    try {
      assertNoJobberUserErrors(result, "createAppointment");
    } catch (error) {
      expect(error).toMatchObject({
        code: "JOBBER_USER_ERROR",
        statusCode: 409,
        operationName: "createAppointment",
        userErrors: result.userErrors,
      });
    }
  });
});
