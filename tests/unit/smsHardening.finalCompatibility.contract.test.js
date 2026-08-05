import fs from "fs";
import path from "path";

const read = (relative) =>
  fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");

describe("SMS hardening final compatibility contracts", () => {
  test("preserves real auth throttling in the Jest environment", () => {
    const source = read("src/middleware/login-rate-limit.js");

    expect(source).not.toContain("CALLBACKIQ_TEST_RATE_LIMIT_BYPASS");
    expect(source).not.toContain("testSafeLoginRateLimit");
    expect(source).toMatch(/export\s+default\s+[A-Za-z_$][\w$]*\s*;/);
  });

  test("fails soft when deterministic alert assessment is unavailable", () => {
    const source = read("src/services/twilioSmsWebhook.service.js");

    expect(source).toContain('|| { alertPriority: "low", riskFlags: [] }');
    expect(source).toContain("Promise.resolve(failTwilioWebhookEvent(");
  });

  test("full-flow queue coverage supplies a deterministic assessment", () => {
    const source = read("tests/integration/smsRecovery.fullFlow.test.js");

    expect(source).toContain("CALLBACKIQ_FULL_FLOW_GUARDRAIL_DEFAULT");
    expect(source).toContain('alertPriority: "medium"');
    expect(source).toContain("riskFlags: []");
  });
});
