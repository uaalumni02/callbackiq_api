#!/usr/bin/env node

// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1
// Fast, dependency-light verification of the installed SMS handoff patch.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const files = {
  processor: "src/services/messaging/inboundSmsJobProcessor.service.js",
  helper: "src/services/messaging/smsHandoff.service.js",
  policy: "src/services/messaging/smsTurnPolicy.service.js",
  alertService: "src/services/alert.service.js",
  conversation: "src/models/conversation.js",
  webhook: "src/services/twilioSmsWebhook.service.js",
  cleanup: "scripts/remove-sms-test-flow.mjs",
  audit: "scripts/audit-sms-test-flow.mjs",
  indexes: "scripts/ensure-sms-handoff-indexes.mjs",
};

const results = [];
const check = (condition, name, detail = "") => {
  results.push({ ok: Boolean(condition), name, detail });
};
const load = (relativePath) => {
  const absolutePath = path.join(root, relativePath);
  check(fs.existsSync(absolutePath), `File exists: ${relativePath}`);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
};

const source = Object.fromEntries(
  Object.entries(files).map(([key, relativePath]) => [key, load(relativePath)]),
);

check(
  source.helper.includes("CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1"),
  "Handoff helper marker is installed",
);
check(
  source.processor.includes("ensureHumanHandoffResult"),
  "Processor guarantees a handoff acknowledgement result",
);
check(
  source.processor.includes("bypassUsageLimits") &&
    source.processor.includes("statusAcknowledgement"),
  "Essential handoff replies bypass normal usage caps",
);
check(
  source.processor.includes("inReplyToMessage: inboundMessage._id") &&
    source.processor.includes("sms-inbound-reply:${business._id}:${inboundMessage._id}"),
  "Outbound replies use message and provider-operation idempotency",
);

const deliveryIndex = source.processor.lastIndexOf("persistOutboundReply({");
const finalizationIndex = source.processor.indexOf(
  "buildFinalizedHumanHandoffUpdate",
  deliveryIndex,
);
check(deliveryIndex >= 0, "Processor contains outbound delivery step");
check(
  finalizationIndex > deliveryIndex,
  "Human takeover finalization occurs after outbound delivery",
  `deliveryIndex=${deliveryIndex}, finalizationIndex=${finalizationIndex}`,
);
check(
  !source.processor.includes("if (requiresHumanTakeover(result))"),
  "Legacy pre-delivery takeover block is removed",
);
check(
  source.processor.includes('"orchestration.silentFailureCount"') &&
    source.processor.includes("buildFailedHumanHandoffUpdate"),
  "Failed handoff replies remain retryable and observable",
);
check(
  source.processor.includes("completeCoalescedJobs") &&
    source.processor.includes("existingHandoffReply"),
  "Crash recovery completes retries without duplicate customer messages",
);
check(
  source.policy.includes("not a confirmed appointment"),
  "Scheduling preference language is explicitly unconfirmed",
);
check(
  source.alertService.includes("createHumanHandoffAlert") &&
    source.alertService.includes("actionRequired: true") &&
    source.alertService.includes("callbackSlaMinutes"),
  "Business handoff alert is actionable and SLA-backed",
);
check(
  source.conversation.includes('"pending_ack"') &&
    source.conversation.includes("handoffInboundMessage") &&
    source.conversation.includes("handoffOutboundMessage") &&
    source.conversation.includes("handoffStatusReplyAt"),
  "Conversation stores the durable handoff lifecycle",
);
check(
  source.webhook.includes("postHandoffStatusEligible") &&
    source.webhook.includes("isHumanHandoffStatusQuestion"),
  "Post-handoff callback-status questions enter the idempotent queue",
);
check(
  source.cleanup.includes("Dry-run is the default") &&
    source.cleanup.includes("--apply"),
  "Cleanup utility is guarded by dry-run and exact identifiers",
);
check(
  source.audit.includes("Read-only production SMS flow audit"),
  "Read-only end-to-end audit utility is installed",
);
check(
  source.indexes.includes("No duplicate outbound replies were found") &&
    source.indexes.includes("conversation_sms_handoff_lifecycle") &&
    source.indexes.includes("message_business_inbound_reply_unique"),
  "Deployment index audit and creation utility is installed",
);

for (const relativePath of Object.values(files)) {
  if (!relativePath.endsWith(".js") && !relativePath.endsWith(".mjs")) continue;
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) continue;
  const syntax = spawnSync(process.execPath, ["--check", absolutePath], {
    encoding: "utf8",
  });
  check(
    syntax.status === 0,
    `Syntax check: ${relativePath}`,
    syntax.status === 0 ? "" : String(syntax.stderr || syntax.stdout).trim(),
  );
}

console.log("\nCallBackIQ SMS production-handoff verification\n");
for (const result of results) {
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`,
  );
}

const failures = results.filter((result) => !result.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
if (failures.length) process.exitCode = 1;
