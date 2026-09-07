import securityHeaders from "../../src/middleware/security-headers.js";
import csrfOriginGuard from "../../src/middleware/csrf-origin-guard.js";

const createResponse = () => {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    setHeader: jest.fn((key, value) => {
      headers[key] = value;
    }),
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this.body = body;
      return this;
    }),
  };
};

describe("security hardening middleware", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "production" };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("security headers include production HSTS and anti-framing controls", () => {
    const res = createResponse();
    const next = jest.fn();

    securityHeaders({}, res, next);

    expect(res.headers["Strict-Transport-Security"]).toContain("max-age=");
    expect(res.headers["X-Frame-Options"]).toBe("DENY");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("CSRF guard rejects unsafe cookie-auth request without origin", () => {
    const req = {
      method: "POST",
      cookies: { token: "cookie-token" },
      headers: {},
      requestId: "req-1",
      originalUrl: "/api/example",
      path: "/api/example",
      protocol: "https",
      get(name) {
        const normalized = String(name).toLowerCase();
        if (normalized === "host") return "api.example.com";
        return this.headers[normalized] || "";
      },
    };
    const res = createResponse();
    const next = jest.fn();

    csrfOriginGuard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("CSRF_ORIGIN_REJECTED");
  });

  test("CSRF guard does not interfere with bearer-only requests", () => {
    const req = {
      method: "POST",
      cookies: {},
      headers: { authorization: "Bearer explicit-token" },
      get(name) {
        return this.headers[String(name).toLowerCase()] || "";
      },
    };
    const res = createResponse();
    const next = jest.fn();

    csrfOriginGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
  test("an arbitrary bearer header cannot bypass cookie CSRF validation", () => {
    const req = { method: "POST", cookies: { token: "cookie-token" }, headers: { authorization: "Bearer arbitrary" }, get(name) { return this.headers[name] || ""; } };
    const res = createResponse(); const next = jest.fn();
    csrfOriginGuard(req, res, next);
    expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403);
  });

});
