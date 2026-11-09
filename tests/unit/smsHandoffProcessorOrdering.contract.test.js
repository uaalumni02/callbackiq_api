// SMS_STAGE3_DELIVERY_SOURCE_CONTRACT_V1: implementation moved, behavior contract retained.
import { readFileSync as readSmsStage3File } from "node:fs";
import { join as joinSmsStage3Path } from "node:path";

const smsStage3DeliverySource = readSmsStage3File(
  joinSmsStage3Path(process.cwd(),
    "src/services/messaging/smsOutboundDelivery.adapter.js"), "utf8");

test("Stage 3 SMS outbound adapter is still wired into the processor", () => {
  const processor = readSmsStage3File(
    joinSmsStage3Path(process.cwd(),
      "src/services/messaging/inboundSmsJobProcessor.service.js"), "utf8");
  expect(processor).toContain("const persistOutboundReply = createSmsOutboundDelivery(");
  expect(processor).toContain("import { createSmsOutboundDelivery }");
});

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
const reply = fs.readFileSync(path.join(process.cwd(), "src/services/messaging/inboundSmsReply.service.js"), "utf8");
const replyRouting = reply.slice(reply.indexOf("export async function routeConversationReply"));
const webhookSource = fs.readFileSync(webhookPath, "utf8");
const deterministicActions = fs.readFileSync(
  path.join(process.cwd(), "src/services/messaging/inboundSmsDeterministicActions.service.js"),
  "utf8",
);

describe("SMS handoff processor ordering contract", () => {
  it("prepares a guaranteed acknowledgement before attempting delivery", () => {
    expect(reply).toContain("ensureHumanHandoffResult");
    expect(replyRouting.indexOf("await prepareConversationReply(")).toBeGreaterThan(-1);
    expect(replyRouting.indexOf("await prepareConversationReply(")).toBeLessThan(
      replyRouting.indexOf("await deliverConversationReply("),
    );
  });

  it("does not commit human takeover before the outbound delivery result", () => {
    const deliveryIndex = replyRouting.indexOf("await deliverConversationReply(");
    const finalizationIndex = replyRouting.indexOf("await finalizeConversationHandoff(");

    expect(deliveryIndex).toBeGreaterThan(-1);
    expect(finalizationIndex).toBeGreaterThan(deliveryIndex);
    expect(reply).not.toContain("if (requiresHumanTakeover(result))");
  });

  it("retains idempotency by linking one outbound reply to one inbound message", () => {
    expect(source).toContain("inReplyToMessage: inboundMessage._id");
    expect(source).toContain("providerMessageId");
    expect(smsStage3DeliverySource).toContain("sms-inbound-reply:${business._id}:${inboundMessage._id}");
    expect(source).toContain("existingHandoffReply");
  });

  it("records a retryable failure instead of permanently muting AI", () => {
    expect(reply).toContain("buildFailedHumanHandoffUpdate");
    expect(reply).toContain('"orchestration.silentFailureCount"');
    expect(reply).toContain("SMS_HANDOFF_ACK_REQUIRED");
  });

  it("allows only deterministic callback-status questions after human takeover", () => {
    expect(webhookSource).toContain("postHandoffStatusEligible");
    expect(webhookSource).toContain("isHumanHandoffStatusQuestion");
    expect(source).toContain("return handleSmsContactControl({");
    expect(deterministicActions).toContain("human_handoff_status_throttled");
  });

  it("bypasses ordinary limits only for essential handoff control messages", () => {
    expect(smsStage3DeliverySource).toContain("bypassUsageLimits");
    expect(smsStage3DeliverySource).toContain("result?.handoff?.required === true");
    expect(smsStage3DeliverySource).toContain("result?.handoff?.statusAcknowledgement === true");
  });
});
