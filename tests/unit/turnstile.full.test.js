import {
  getClientIp,
  verifyTurnstileToken,
} from "../../src/helpers/security/turnstile.js";

const makeReq = (overrides = {}) => ({
  headers: {},
  ip: "127.0.0.1",
  socket: { remoteAddress: "127.0.0.2" },
  ...overrides,
});

describe("Cloudflare Turnstile helper", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TURNSTILE_SECRET_KEY: "secret",
      TURNSTILE_TIMEOUT_MS: "5000",
    };
    global.fetch = jest.fn();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test("resolves client IP from forwarded, Express, and socket sources", () => {
    expect(
      getClientIp(makeReq({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })),
    ).toBe("1.2.3.4");
    expect(getClientIp(makeReq({ ip: "9.9.9.9" }))).toBe("9.9.9.9");
    expect(
      getClientIp(makeReq({ ip: "", socket: { remoteAddress: "8.8.8.8" } })),
    ).toBe("8.8.8.8");
  });

  test("fails closed when the secret is missing", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    await expect(verifyTurnstileToken("token", makeReq())).resolves.toEqual({
      success: false,
      reason: "challenge_not_configured",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects a missing challenge token", async () => {
    await expect(verifyTurnstileToken("  ", makeReq())).resolves.toEqual({
      success: false,
      reason: "challenge_token_missing",
    });
  });

  test("verifies a valid token and sends the client IP", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        success: true,
        hostname: "app.callbackiq.com",
        action: "register",
        "error-codes": [],
      }),
    });
    process.env.TURNSTILE_EXPECTED_HOSTNAME = "app.callbackiq.com";
    process.env.TURNSTILE_EXPECTED_ACTION = "register";

    await expect(
      verifyTurnstileToken(
        " challenge-token ",
        makeReq({ headers: { "x-forwarded-for": "1.2.3.4" } }),
      ),
    ).resolves.toEqual({ success: true, reason: null, errors: [] });

    const options = global.fetch.mock.calls[0][1];
    expect(options.method).toBe("POST");
    expect(options.body).toContain("secret=secret");
    expect(options.body).toContain("response=challenge-token");
    expect(options.body).toContain("remoteip=1.2.3.4");
  });

  test.each([
    [{ success: false, "error-codes": ["invalid-input-response"] }, "challenge_invalid"],
    [{ success: true, hostname: "wrong.example.com" }, "challenge_invalid"],
    [{ success: true, hostname: "app.callbackiq.com", action: "wrong" }, "challenge_invalid"],
  ])("rejects invalid verification result %#", async (result, reason) => {
    process.env.TURNSTILE_EXPECTED_HOSTNAME = "app.callbackiq.com";
    process.env.TURNSTILE_EXPECTED_ACTION = "register";
    global.fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(result),
    });
    const response = await verifyTurnstileToken("token", makeReq());
    expect(response.success).toBe(false);
    expect(response.reason).toBe(reason);
  });

  test("handles a non-OK provider response", async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(verifyTurnstileToken("token", makeReq())).resolves.toEqual({
      success: false,
      reason: "challenge_service_error",
    });
  });

  test("handles fetch failures safely", async () => {
    global.fetch.mockRejectedValue(new Error("network down"));
    await expect(verifyTurnstileToken("token", makeReq())).resolves.toEqual({
      success: false,
      reason: "challenge_service_error",
    });
  });
});
