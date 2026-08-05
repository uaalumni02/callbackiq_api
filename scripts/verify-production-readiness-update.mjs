#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
  "src/models/communicationUsageReservation.js",
  "src/models/manualSmsOperation.js",
  "src/models/smsContactDisclosure.js",
  "src/models/voiceConnectionBucket.js",
  "src/models/voiceSettingsVersion.js",
  "src/models/voiceUsageReservation.js",
  "src/models/voiceUsageReconciliation.js",
  "src/services/communicationUsageReservation.service.js",
  "src/services/messaging/manualSmsOperation.service.js",
  "src/services/messaging/manualSmsPolicy.service.js",
  "src/services/messaging/manualConversationMessage.service.js",
  "src/services/smsContactDisclosure.service.js",
  "src/services/trustedProxyAddress.service.js",
  "src/services/twilioStatusBusinessResolver.service.js",
  "src/services/voiceConnectionLease.service.js",
  "src/services/voiceSettingsContract.service.js",
  "src/services/voiceSettingsVersion.service.js",
  "src/services/voiceTurnContext.service.js",
  "src/services/voiceUsage.service.js",
  "scripts/reconcile-manual-sms-operations.mjs",
  "scripts/sweep-expired-sms-disclosures.mjs",
];
const contracts = [
  ["src/services/twilioSmsService.js", "SMS_DELIVERY_RECONCILIATION_REQUIRED"],
  ["src/services/twilioSmsService.js", "claimSmsContactDisclosure"],
  ["src/services/twilioSmsWebhook.service.js", "executeManualSmsOperation"],
  ["src/services/communicationUsage.service.js", "releaseCommunicationUsage"],
  ["src/services/communicationUsageReservation.service.js", "state: \"released\""],
  ["src/services/messaging/manualSmsOperation.service.js", "reconcileDispatchingOperation"],
  ["src/models/message.js", "clientOperationId"],
  ["src/controllers/voiceSettings.js", "validateVoiceSettingsDraft"],
  ["src/controllers/voiceSettings.js", "publishVoiceSettingsVersion"],
  ["src/routes/voiceSettings.routes.js", "/rollback/:version"],
  ["src/services/voiceSettingsVersion.service.js", "compensating_restore_failed"],
  ["src/services/voiceUsage.service.js", "withTransaction"],
  ["src/services/voiceUsage.service.js", "voice_usage_atomic_reservation_unavailable"],
  ["src/voice/conversationRelay.server.js", "abortController = new AbortController"],
  ["src/voice/conversationRelay.server.js", "distributed expiring admission leases"],
  ["src/voice/conversationRelay.server.js", "duration_limit_callback_captured"],
  ["src/voice/voiceCallback.service.js", "assertVoiceTurnActive"],
  ["src/voice/voiceHandoff.service.js", "assertVoiceTurnActive"],
  ["src/services/booking/bookingStateMachine.service.js", "assertVoiceTurnActive"],
  ["src/helpers/ai/tools/sendConfirmationSms.tool.js", "assertVoiceTurnActive"],
];
const failures = [];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`${relative} is missing`);
}
for (const [relative, marker] of contracts) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes(marker)) {
    failures.push(`${relative} is missing contract: ${marker}`);
  }
}
if (failures.length) {
  console.error(`Production-readiness verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Production-readiness verification passed: ${required.length + contracts.length} checks.`);
