#!/usr/bin/env node
import fs from "fs";
import path from "path";

const root = process.cwd();
const failures = [];
const passes = [];

const read = (relative) => {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`Missing required file: ${relative}`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
};

const expectText = (relative, pattern, description) => {
  const text = read(relative);
  const matched = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  if (matched) passes.push(description);
  else failures.push(`${description} (${relative})`);
};

const walkJavaScript = (directory) => {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkJavaScript(absolute));
    else if (/\.[cm]?js$/.test(entry.name)) output.push(absolute);
  }
  return output;
};

const requiredFiles = [
  "src/services/twilioSmsService.js",
  "src/services/communicationUsage.service.js",
  "src/services/outboundSmsAudit.service.js",
  "src/services/voiceCapacity.service.js",
  "src/middleware/twilio-webhook-rate-limit.js",
  "src/helpers/logging/safeLogger.js",
  "src/models/communicationUsage.js",
  "src/models/communicationRouteRateLimit.js",
  "src/models/outboundSmsAudit.js",
  "src/models/voiceCapacity.js",
  "tests/unit/communicationSafety.aiCounter.test.js",
  "tests/unit/communicationSafety.smsPolicy.test.js",
  "tests/unit/communicationSafety.usageBudgets.test.js",
  "tests/unit/communicationSafety.rateLimit.test.js",
  "tests/unit/communicationSafety.voiceCapacity.test.js",
  "tests/unit/communicationSafety.voiceRelayLimits.test.js",
  "tests/unit/communicationSafety.safeLogger.test.js",
];
for (const file of requiredFiles) read(file);

expectText(
  "src/controllers/twilio.js",
  /const \{ to, body \} = req\.body;/,
  "Manual SMS ignores caller-provided sender numbers",
);
expectText(
  "src/controllers/twilio.js",
  /businessId: business\._id,[\s\S]*actorId,[\s\S]*source: "manual_sms"/,
  "Manual SMS derives tenant context and records the actor",
);
expectText(
  "src/routes/twilio.routes.js",
  /"\/send-sms",[\s\S]*checkAuth,[\s\S]*checkSubscription,[\s\S]*manualSmsRateLimit/,
  "Manual SMS route requires auth, subscription, and throttling",
);
expectText(
  "src/routes/agent.routes.js",
  /"\/reply",[\s\S]*checkAuth,[\s\S]*checkSubscription,[\s\S]*agentReplyRateLimit/,
  "Agent reply requires auth, subscription, and throttling",
);
expectText(
  "src/controllers/agent.js",
  /sendSms\(\{[\s\S]*businessId: business\._id/,
  "Agent replies use the centralized SMS policy",
);
expectText(
  "src/services/automation/automation.service.js",
  /sendSms\(\{[\s\S]*actorType: "automation"/,
  "Automation replies use the centralized SMS policy",
);
expectText(
  "src/models/message.js",
  /isAiGenerated:[\s\S]*generatedBy:[\s\S]*metadata:/,
  "Message schema persists AI counter metadata",
);
expectText(
  "src/db/db.js",
  /isAiGenerated generatedBy usageCategory actorType actorId metadata/,
  "AI transcript queries load persisted counter metadata",
);
expectText(
  "src/services/aiReplyService.js",
  /reserveAiUsage\(\{/,
  "AI calls reserve tenant and customer budgets",
);
expectText(
  "src/models/business.js",
  /communicationLimits:[\s\S]*CommunicationLimitsSchema/,
  "Business configuration includes communication budgets",
);
expectText(
  "src/models/business.js",
  /maxConcurrentCalls:[\s\S]*maxCallDurationSeconds:/,
  "Business configuration includes voice concurrency and duration limits",
);
expectText(
  "src/voice/conversationRelay.server.js",
  /acquireVoiceCapacity[\s\S]*scheduleDurationLimit/,
  "ConversationRelay acquires capacity and schedules a duration limit",
);
expectText(
  "src/voice/conversationRelay.server.js",
  /releaseVoiceCapacity/,
  "ConversationRelay releases voice capacity",
);
expectText(
  "src/voice/conversationRelay.server.js",
  /voiceCapacityService = VoiceCapacityService[\s\S]*failureEndDelayMs = DEFAULT_END_DELAY_MS[\s\S]*durationLimitMs = null[\s\S]*forceFailureAfterSetup/,
  "ConversationRelay preserves dependency injection and staged failure controls",
);
expectText(
  "src/voice/conversationRelay.server.js",
  /VoiceFailureService[\s\S]*determineVoiceFailureRoute[\s\S]*VOICE_ROUTE\.DIAL_STAFF/,
  "ConversationRelay preserves the configured staff-first fallback policy",
);
expectText(
  "src/voice/voiceSession.service.js",
  /sendSms\(\{[\s\S]*actorType: "voice"[\s\S]*source: "voice_fallback"/,
  "Voice fallback SMS uses the centralized policy",
);
expectText(
  "src/voice/voiceSession.service.js",
  /logOperationalError[\s\S]*logOperationalWarning/,
  "Voice fallback logging is redacted",
);
expectText(
  "src/services/communicationUsage.service.js",
  /createSystemAlert[\s\S]*dedupeKey: `communication_usage:/,
  "Usage threshold alerts are deduplicated",
);
expectText(
  "src/controllers/twilio.js",
  /logOperationalEvent[\s\S]*logOperationalError/,
  "Twilio controllers use redacted operational logging",
);

const forbiddenLogFragments = [
  "TWILIO VOICE BODY:",
  "TWILIO STATUS BODY:",
  "TWILIO SMS BODY:",
  "MISSED/FORWARDED CALL FROM:",
  "TWILIO NUMBER:",
];
const twilioController = read("src/controllers/twilio.js");
for (const fragment of forbiddenLogFragments) {
  if (twilioController.includes(fragment)) {
    failures.push(`Raw Twilio PII logging remains: ${fragment}`);
  }
}
if (!forbiddenLogFragments.some((fragment) => twilioController.includes(fragment))) {
  passes.push("Raw Twilio request and phone logging removed");
}

const voiceSessionService = read("src/voice/voiceSession.service.js");
const forbiddenVoiceLogs = [
  "Voice fallback SMS preference check failed:",
  "Voice fallback SMS was sent but could not be fully logged:",
];
for (const fragment of forbiddenVoiceLogs) {
  if (voiceSessionService.includes(fragment)) {
    failures.push(`Raw voice operational logging remains: ${fragment}`);
  }
}
if (!forbiddenVoiceLogs.some((fragment) => voiceSessionService.includes(fragment))) {
  passes.push("Raw voice fallback error logging removed");
}

const allowedTransport = path.normalize(
  path.join(root, "src/services/twilioSmsService.js"),
);
const directSendFiles = walkJavaScript(path.join(root, "src"))
  .filter((file) => path.normalize(file) !== allowedTransport)
  .filter((file) => /\.messages\.create\s*\(/.test(fs.readFileSync(file, "utf8")))
  .map((file) => path.relative(root, file));
if (directSendFiles.length) {
  failures.push(
    `Direct Twilio SMS sends remain outside twilioSmsService.js: ${directSendFiles.join(", ")}`,
  );
} else {
  passes.push("All outbound Twilio SMS sends are centralized");
}

console.log(`Communication safety structure: ${passes.length} passed.`);
for (const item of passes) console.log(`  PASS ${item}`);
if (failures.length) {
  console.error(`\nCommunication safety structure: ${failures.length} failed.`);
  for (const item of failures) console.error(`  FAIL ${item}`);
  process.exit(1);
}
