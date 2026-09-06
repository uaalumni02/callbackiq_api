import { getTrustedRequestIp } from "../../src/helpers/security/trustedRequestIp.js";

describe("release invariant: account security uses Express trusted proxy resolution", () => {
  test("uses req.ip rather than a raw X-Forwarded-For header", () => {
    const req = {
      ip: "203.0.113.10",
      headers: {
        "x-forwarded-for": "198.51.100.99, 203.0.113.20",
      },
      socket: {
        remoteAddress: "10.0.0.5",
      },
    };

    expect(getTrustedRequestIp(req)).toBe("203.0.113.10");
  });

  test("falls back to socket address when req.ip is unavailable", () => {
    expect(
      getTrustedRequestIp({
        socket: { remoteAddress: "::ffff:192.0.2.50" },
      }),
    ).toBe("192.0.2.50");
  });
});
