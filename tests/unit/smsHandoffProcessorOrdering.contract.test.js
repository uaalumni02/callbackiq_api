import fs from "node:fs";
import path from "node:path";

const processorPath = path.join(
  process.cwd(),
  "src/services/messaging/inboundSmsJobProcessor.service.js",
);
const webhookPath = path.join(
  process.cwd(),
  "src/services/twilioSmsWebhook.service.js",
);

const source = fs.readFileSync(processorPath, "utf8");
const webhookSource = fs.readFileSync(webhookPath, "utf8");

describe("SMS handoff processor ordering contract", () => {
  it("prepares a guaranteed acknowledgement before attempting delivery", () => {
    expect(source).toContain("ensureHumanHandoffResult");
    expect(source.indexOf("ensureHumanHandoffResult")).toBeLessThan(
      source.lastIndexOf("persistOutboundReply({"),
    );
  });

  it("does not commit human takeover before the outbound delivery result", () => {
    const deliveryIndex = source.lastIndexOf("persistOutboundReply({");
    const finalizationIndex = source.indexOf(
      "buildFinalizedHumanHandoffUpdate",
      deliveryIndex,
    );

    expect(deliveryIndex).toBeGreaterThan(-1);
    expect(finalizationIndex).toBeGreaterThan(deliveryIndex);
    expect(source).not.toContain("if (requiresHumanTakeover(result))");
  });

  it("retains idempotency by linking one outbound reply to one inbound message", () => {
    expect(source).toContain("inReplyToMessage: inboundMessage._id");
    expect(source).toContain("providerMessageId");
    expect(source).toContain("sms-inbound-reply:${business._id}:${inboundMessage._id}");
    expect(source).toContain("existingHandoffReply");
  });

  it("records a retryable failure instead of permanently muting AI", () => {
    expect(source).toContain("buildFailedHumanHandoffUpdate");
    expect(source).toContain('"orchestration.silentFailureCount"');
    expect(source).toContain("SMS_HANDOFF_ACK_REQUIRED");
  });

  it("allows only deterministic callback-status questions after human takeover", () => {
    expect(webhookSource).toContain("postHandoffStatusEligible");
    expect(webhookSource).toContain("isHumanHandoffStatusQuestion");
    expect(source).toContain("human_handoff_status_throttled");
  });

  it("bypasses ordinary limits only for essential handoff control messages", () => {
    expect(source).toContain("bypassUsageLimits");
    expect(source).toContain("result?.handoff?.required === true");
    expect(source).toContain("result?.handoff?.statusAcknowledgement === true");
  });
});
