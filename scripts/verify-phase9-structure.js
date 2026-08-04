#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const passed = [];

const absolute = (relative) => path.join(root, relative);
const read = (relative) => {
  const filename = absolute(relative);
  if (!fs.existsSync(filename)) {
    failures.push(`Missing ${relative}`);
    return "";
  }
  return fs.readFileSync(filename, "utf8");
};

const requireAll = (relative, tokens) => {
  const text = read(relative);
  for (const token of tokens) {
    if (!text.includes(token)) {
      failures.push(`${relative} is missing required behavior: ${token}`);
    }
  }
  return text;
};

const requirePattern = (relative, pattern, message) => {
  const text = read(relative);
  if (!pattern.test(text)) failures.push(message || `${relative} failed ${pattern}`);
  return text;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const getPostRoute = (text, routePath) => {
  const pattern = new RegExp(
    `router\\.post\\(\\s*["']${escapeRegex(routePath)}["']\\s*,([\\s\\S]*?)\\n?\\s*\\);`,
    "m",
  );
  return text.match(pattern)?.[1] || "";
};

const assertRoute = ({
  routes,
  routePath,
  controller,
  rateLimiter,
  additional = [],
}) => {
  const block = getPostRoute(routes, routePath);
  if (!block) {
    failures.push(`src/routes/twilio.routes.js is missing POST ${routePath}`);
    return;
  }
  const ordered = ["validateTwilioSignature", rateLimiter, ...additional, controller];
  let previous = -1;
  for (const token of ordered) {
    const index = block.indexOf(token);
    if (index < 0) {
      failures.push(`POST ${routePath} is missing ${token}`);
      continue;
    }
    if (index < previous) {
      failures.push(`POST ${routePath} has middleware in an unsafe order near ${token}`);
    }
    previous = index;
  }
};

const routes = requireAll("src/routes/twilio.routes.js", [
  "validateTwilioSignature",
  "twilioVoiceWebhookRateLimit",
  "VoiceWebhookController",
]);

for (const definition of [
  ["/voice", "VoiceWebhookController.initial"],
  ["/voice-overflow", "VoiceWebhookController.overflow"],
  ["/voice-complete", "VoiceWebhookController.complete"],
  ["/voice-transfer-complete", "VoiceWebhookController.transferComplete"],
  ["/voice-staff-screen", "VoiceWebhookController.staffScreen"],
  ["/voice-staff-screen-decision", "VoiceWebhookController.staffScreenDecision"],
]) {
  assertRoute({
    routes,
    routePath: definition[0],
    controller: definition[1],
    rateLimiter: "twilioVoiceWebhookRateLimit",
  });
}

assertRoute({
  routes,
  routePath: "/status",
  controller: "TwilioController.statusWebhook",
  rateLimiter: "twilioStatusWebhookRateLimit",
  additional: ["missedCallAutomationLifecycle"],
});
assertRoute({
  routes,
  routePath: "/sms",
  controller: "TwilioController.handleInboundSms",
  rateLimiter: "twilioSmsWebhookRateLimit",
  additional: ["inboundSmsLifecycle"],
});

const business = requireAll("src/models/business.js", [
  "VoiceRoutingPolicySchema",
  "VoiceSettingsSchema",
  "recordingEnabled",
  "maxCallDurationSeconds",
  "liveTransferPhone",
  "normalizePhoneToE164 as normalizeVoicePhone",
  "normalizeVoicePhoneFields",
]);
if (!/overflowRingSeconds\s*:\s*\{[\s\S]{0,220}?min\s*:\s*15[\s\S]{0,220}?max\s*:\s*25/.test(business)) {
  failures.push("Business overflowRingSeconds must be constrained to 15–25 seconds.");
}
if (!/maxCallDurationSeconds\s*:\s*\{[\s\S]{0,220}?max\s*:\s*600[\s\S]{0,220}?default\s*:\s*600/.test(business)) {
  failures.push("Business maxCallDurationSeconds must hard-cap and default to 600 seconds.");
}
if (!/welcomeGreeting\s*:\s*\{[\s\S]{0,220}?default\s*:\s*["']{2}/.test(business)) {
  failures.push("Business welcomeGreeting must default blank so the dynamic business-name greeting is used.");
}

requireAll("src/models/voiceSession.js", [
  '"capturing_callback"',
  '"safety_escalated"',
  '"completing"',
  '"fallback_sms"',
  "lastActivityAt",
  "signatureValidated",
  "{ business: 1, providerCallSid: 1 }",
  "{ unique: true }",
]);

requireAll("src/voice/voiceTimeWindow.service.js", [
  "withinTimeWindow",
  'return end < start ? "overnight" : "same_day"',
  'if (kind === "all_day")',
  "return 1440",
]);

const relay = requireAll("src/voice/conversationRelay.server.js", [
  'const PATH = "/ws/voice"',
  'request.headers?.["x-twilio-signature"]',
  "signatureUrlForRequest",
  "validateTwilioRequestWithRotation",
  "signatureValidator(request)",
  "wss.handleUpgrade",
  "DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000",
  "DEFAULT_IDLE_FIRST_MS = 15_000",
  "DEFAULT_IDLE_SECOND_MS = 30_000",
  "DEFAULT_IDLE_END_MS = 45_000",
  "DEFAULT_SOFT_TURN_TIMEOUT_MS = 2_500",
  "DEFAULT_HARD_TURN_TIMEOUT_MS = 15_000",
  "DEFAULT_MAX_CALL_DURATION_SECONDS = 600",
  'error?.code !== "VOICE_TURN_TIMEOUT"',
  "maxPendingConnectionsPerIp",
  'message.type === "interrupt"',
  'message.type === "dtmf"',
  "isTransientDependencyError",
  "safeSend",
]);
requireAll("src/services/twilioSignatureRotation.service.js", [
  "validateTwilioRequestWithRotation",
  "twilio.validateRequest",
  "TWILIO_AUTH_TOKEN_NEXT",
  "TWILIO_AUTH_TOKEN_PREVIOUS",
]);
const signatureIndex = relay.indexOf("signatureValidator(request)");
const guardIndex = relay.indexOf("if (!signatureIsValid)");
const upgradeIndex = relay.indexOf("wss.handleUpgrade");
if (
  signatureIndex < 0 ||
  guardIndex < 0 ||
  upgradeIndex < 0 ||
  !(signatureIndex < guardIndex && guardIndex < upgradeIndex)
) {
  failures.push("ConversationRelay must validate and reject the Twilio signature before WSS upgrade.");
}

requireAll("src/voice/voicePhone.service.js", [
  "normalizePhoneToE164",
  "isUsableCallerId",
  "phoneLookupVariants",
  "phoneNumbersEqual",
]);
requireAll("src/voice/voiceInput.service.js", [
  "NON_ENGLISH_MARKERS",
  "CALLBACK_PAST_PATTERN",
  "HOURS_CONTEXT_PATTERN",
  "isHumanRequest",
  "isBookingIntent",
  "isCallbackRequest",
  "extractCallbackDetails",
  "isCancelIntent",
  "parseCorrection",
  "isSkipIntent",
  "sanitizeDtmfDigits",
  "toSpokenReply",
  "isTransientDependencyError",
]);
requireAll("src/voice/voiceAvailability.service.js", [
  "windowKind",
  "previousDateKey",
  "resolveBusinessTimeZone",
  "formatClockTimeForSpeech",
  "previousDaySpillover",
]);
requireAll("src/voice/voiceLineType.service.js", [
  "lineTypeIntelligence",
  "landline",
  "smsCapable",
]);

const sessionService = requireAll("src/voice/voiceSession.service.js", [
  "TERMINAL_STATUSES",
  "TRANSITIONS",
  "findContext",
  "sanitizeMetadata",
  "...sanitizeMetadata(metadata)",
  "fallbackSmsStatus",
  "isUsableCallerId",
  "VoiceLineTypeService.lookup",
]);
if ((sessionService.match(/static async ensureContext/g) || []).length !== 1) {
  failures.push("VoiceSessionService must expose exactly one idempotent ensureContext implementation.");
}

const webhook = requireAll("src/controllers/voiceWebhook.js", [
  "normalizePhoneToE164",
  "phoneLookupVariants",
  "findExistingContext",
  "staffScreen",
  "staffScreenDecision",
  "staffAccepted",
  "VoiceSessionService.ensureContext",
  "VoiceSessionService.findContext",
]);
if ((webhook.match(/VoiceSessionService\.ensureContext\(/g) || []).length !== 1) {
  failures.push("Only the initial voice webhook may create voice context; callbacks must be find-only.");
}

requireAll("src/voice/voiceRouting.service.js", [
  "dynamicGreeting",
  "businessName",
  "trackingPhone",
  "phoneNumbersEqual",
  "overflowRingSeconds",
  "maxCallDurationSeconds",
  "ConversationRelay",
  "<Parameter",
  'answerOnBridge="true"',
  "staffScreenPromptTwiml",
  "staffScreenDecisionTwiml",
  "VOICE_RECORDING_SUPPORTED = false",
]);
requireAll("src/controllers/voiceSettings.js", [
  '"VOICE_RECORDING_NOT_AVAILABLE"',
  "assertNoDialLoops",
  "trackingPhone",
  "voiceAnsweringReady",
  "automaticBookingEnabled",
  "maxCallDurationSeconds",
  "overflowRingSeconds",
]);
requireAll("src/services/voiceCapacity.service.js", [
  "VOICE_CAPACITY_MAX_DURATION_SECONDS = 600",
  "resolveVoiceCapacityLimits",
  "sweepExpiredVoiceCapacity",
  "VOICE_CAPACITY_LEASE_GRACE_MS",
]);
requireAll("src/voice/voiceTranscript.service.js", [
  "Guardrails.redactSensitiveData",
  "markLastAssistantInterrupted",
  "isFinal",
]);
requireAll("src/voice/voiceSessionMaintenance.service.js", [
  "reapStaleSessions",
  "redactExpiredTranscripts",
]);

for (const relative of [
  "scripts/reap-stale-voice-sessions.mjs",
  "scripts/redact-expired-voice-transcripts.mjs",
  "scripts/sweep-expired-voice-capacity.mjs",
  "scripts/normalize-business-phone-numbers.mjs",
]) {
  read(relative);
}

const pkgText = read("package.json");
let pkg = {};
try {
  pkg = JSON.parse(pkgText || "{}");
} catch (error) {
  failures.push(`package.json is invalid JSON: ${error.message}`);
}
for (const scriptName of [
  "test:phase9",
  "test:phase9:unit",
  "test:phase9:completion",
  "test:voice-hardening",
  "voice:reap-stale",
  "voice:redact-transcripts",
  "voice:sweep-capacity",
  "voice:migrate-phones",
  "certify:phase9",
]) {
  if (!pkg.scripts?.[scriptName]) failures.push(`package.json is missing ${scriptName}.`);
}
const ignorePatterns = pkg.jest?.testPathIgnorePatterns || [];
for (const expected of ["<rootDir>/tools/", "<rootDir>/hardening-tests/"]) {
  if (!ignorePatterns.some((value) => value.includes(expected.replace("<rootDir>/", "")))) {
    failures.push(`Jest must ignore update/standalone test content matching ${expected}.`);
  }
}

if (failures.length) {
  console.error("Phase 9 production-hardening structure verification failed:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

passed.push(
  "Signed/rate-limited HTTP voice and SMS routes",
  "Signed WSS upgrade and bounded transport",
  "Strict session lifecycle and find-only callbacks",
  "Callback-first dialogue and PII-safe transcript handling",
  "Dedicated screened staff transfer routes",
  "Ten-minute capacity/session limits and maintenance scripts",
  "Recording disabled and readiness separated from booking",
);
console.log("Phase 9 production-hardening structure verification passed.\n");
passed.forEach((item) => console.log(`PASS ${item}`));
