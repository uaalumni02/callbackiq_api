import fs from "node:fs";
import path from "node:path";

const read = (file) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("SMS reliability hardening contracts", () => {
  test("inbound lifecycle middleware no longer runs before the webhook claim", () => {
    const routes = read("src/routes/twilio.routes.js");
    const smsRoute = routes.match(
      /router\.post\(\s*["']\/sms["'][\s\S]*?\n\);/,
    )?.[0];

    expect(smsRoute).toBeTruthy();
    expect(smsRoute).not.toContain("inboundSmsLifecycle");
    expect(routes).toContain("/sms-fallback");
  });

  test("inbound webhook persists OptOutType and durable processing intent", () => {
    const source = read("src/services/twilioSmsWebhook.service.js");
    expect(source).toContain("twilioOptOutType");
    expect(source).toContain("processingRequired");
    expect(source).toContain("runInboundSmsLifecycleAfterClaim");
    expect(source).toContain("sendIdempotentInboundSmsReply");
  });

  test("orphan reconciliation is wired as an independent worker", () => {
    const queue = read(
      "src/services/messaging/smsProcessingQueue.service.js",
    );
    const server = read("src/server.js");

    expect(queue).toContain("reconcileOrphanedInboundSmsJobs");
    expect(server).toContain(
      "startSmsIngressReconciliationWorker",
    );
    expect(server).toContain(
      "stopSmsIngressReconciliationWorker",
    );
  });

  test("Twilio numbers include fallback handlers and retry overrides", () => {
    const provisioning = read(
      "src/services/trackingNumberProvisioning.service.js",
    );
    expect(provisioning).toContain("voiceFallbackUrl");
    expect(provisioning).toContain("smsFallbackUrl");
    expect(provisioning).toContain("buildTwilioWebhookUrls");
  });

  test("Messaging Service preserves number-level inbound webhook reliability", () => {
    const a2p = read(
      "src/services/a2pMessagingRegistration.service.js",
    );
    expect(a2p).toContain("useInboundWebhookOnNumber");
  });

  test("voice routes are monitored for p95 latency", () => {
    const routes = read("src/routes/twilio.routes.js");
    expect(routes).toContain(
      "monitorTwilioVoiceWebhookLatency",
    );
    expect(routes).toContain("/voice-fallback");
  });
});
