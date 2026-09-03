import fs from "node:fs";
import path from "node:path";

const alertSource = fs.readFileSync(
  path.join(process.cwd(), "src/services/alert.service.js"),
  "utf8",
);
const conversationSource = fs.readFileSync(
  path.join(process.cwd(), "src/models/conversation.js"),
  "utf8",
);

describe("SMS human handoff alert and lifecycle contract", () => {
  it("creates a dedicated, deduplicated, actionable callback alert", () => {
    expect(alertSource).toContain("createHumanHandoffAlert");
    expect(alertSource).toContain('type: isEmergency ? "safety_emergency" : "human_requested"');
    expect(alertSource).toContain("actionRequired: true");
    expect(alertSource).toContain("dueAt");
    expect(alertSource).toContain("callbackSlaMinutes");
    expect(alertSource).toContain("SMS_URGENT_CALLBACK_SLA_MINUTES");
    expect(alertSource).toContain("urgent: isUrgent");
    expect(alertSource).toContain("dedupeKey: `human_handoff:");
    expect(alertSource).toContain("return this.create({");
    expect(alertSource).not.toContain(
      "return this.createAutomatic({\n      businessId,\n      leadId,\n      conversationId,\n      type: isEmergency",
    );
  });

  it("persists the complete handoff lifecycle on the conversation", () => {
    for (const field of [
      "handoffStatus",
      "handoffReason",
      "handoffRequestedAt",
      "handoffAcknowledgedAt",
      "handoffInboundMessage",
      "handoffOutboundMessage",
      "handoffCallbackPhone",
      "handoffLastError",
      "handoffStatusReplyAt",
    ]) {
      expect(conversationSource).toContain(field);
    }
  });
});
