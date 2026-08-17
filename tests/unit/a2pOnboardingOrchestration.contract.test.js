import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("A2P onboarding orchestration contract", () => {
  test("SMS readiness requires carrier-confirmed messaging readiness", () => {
    const source = read("src/services/businessReadiness.service.js");
    expect(source).toContain("smsMessagingReady");
    expect(source).toContain("business.messagingCompliance?.smsReady === true");
    expect(source).toContain("checks.smsMessagingReady");
    expect(source).toContain("messaging_registration_pending");
  });

  test("reconciliation worker advances nonterminal A2P registrations", () => {
    const source = read("src/workers/a2pReconciliation.worker.js");
    expect(source).toContain("A2P_RECONCILABLE_STATUSES");
    expect(source).toContain('"brand_pending"');
    expect(source).toContain('"campaign_pending"');
    expect(source).toContain('"number_pending"');
    expect(source).toContain('"otp_required"');
    expect(source).toContain("syncA2pCustomerRegistration");
  });

  test("server starts and stops A2P reconciliation with the process lifecycle", () => {
    const source = read("src/server.js");
    expect(source).toContain("startA2pReconciliationWorker");
    expect(source).toContain("stopA2pReconciliationWorker");
  });
});
