#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

const read = (relative) => {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing ${relative}`);
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
};

const requireAll = (relative, values) => {
  const text = read(relative);
  for (const value of values) {
    if (!text.includes(value)) {
      failures.push(`${relative} is missing: ${value}`);
    }
  }
  return text;
};

const business = requireAll("src/models/business.js", [
  "const VoiceSettingsSchema = new Schema(",
  '"after_hours"',
  '"overflow"',
  '"always"',
  '"disabled"',
  "overflowRingSeconds",
  "transferPhone",
  "welcomeGreeting",
  "voiceName",
  "recordingEnabled",
  "voiceSettings: {",
]);

const leadModel = read("src/models/lead.js");
const leadSourceBlock = leadModel.match(
  /source\s*:\s*\{[\s\S]{0,500}?enum\s*:\s*\[([^\]]*)\]/,
)?.[1];
if (!leadSourceBlock || !/["']voice["']/.test(leadSourceBlock)) {
  failures.push("src/models/lead.js source enum is missing voice.");
}

const session = requireAll("src/models/voiceSession.js", [
  "providerCallSid",
  "providerSessionId",
  "transcript",
  "transferredToHuman",
  "transferReason",
  "appointment",
  "estimatedValue",
  "failureReason",
  "fallbackSmsStatus",
  "fallbackSmsProviderMessageId",
  "confirmationSmsStatus",
  "confirmationSmsSentAt",
  "confirmationSmsProviderMessageId",
  "{ business: 1, providerCallSid: 1 }",
  "{ unique: true }",
]);

const relay = requireAll("src/voice/conversationRelay.server.js", [
  'const PATH = "/ws/voice"',
  "validateConversationRelaySignature",
  'request.headers["x-twilio-signature"]',
  "twilio.validateRequest",
  "wss.handleUpgrade",
  'reasonCode: "voice-failure"',
  "VoiceSessionService.sendFallbackSms",
]);
const signatureGuard = relay.indexOf(
  "if (!validateConversationRelaySignature(request))",
);
const accept = relay.indexOf("wss.handleUpgrade");
if (signatureGuard < 0 || accept < 0 || signatureGuard > accept) {
  failures.push(
    "ConversationRelay must validate the Twilio signature before accepting the WebSocket upgrade.",
  );
}

const webhook = requireAll("src/controllers/voiceWebhook.js", [
  "TwilioController.voiceWebhook(req, res)",
  'settings.answerMode === "after_hours"',
  'settings.answerMode === "overflow"',
  'settings.answerMode === "always"',
  "VoiceAvailabilityService.isBusinessOpen",
  "conversationRelayTwiml",
  "dialTwiml",
  'handoff.reasonCode === "live-agent-handoff"',
  'handoff.reasonCode === "voice-failure"',
  "VoiceSessionService.sendFallbackSms",
]);

const agent = requireAll("src/voice/voiceAgent.service.js", [
  "assessInboundSafety",
  "searchServicesTool",
  "validateServiceAreaTool",
  "BookingStateMachineService.handle",
  'channel: "voice"',
  "sendConfirmationSmsTool",
  "voiceSessionId: session._id",
  "VoiceHandoffService.request",
  "COMPLAINT_OR_DISPUTE",
  "WARRANTY",
  "COMMERCIAL",
  "EXISTING_JOB",
  "COMPLEX_PRICING",
]);
if (
  agent.indexOf("assessInboundSafety") >
  agent.indexOf("BookingStateMachineService.handle")
) {
  failures.push("Voice safety assessment must run before booking logic.");
}

requireAll("src/helpers/ai/tools/sendConfirmationSms.tool.js", [
  "VoiceSession.findOneAndUpdate",
  'confirmationSmsStatus: "sending"',
  'confirmationSmsStatus: "sent"',
  'confirmationSmsStatus: "failed"',
  'confirmationSmsStatus: "suppressed"',
  "duplicate: true",
]);

requireAll("src/voice/voiceSession.service.js", [
  "isSmsSuppressed",
  'source: "voice"',
  "missedCallSmsEnabled",
  'fallbackSmsStatus: "suppressed"',
  'fallbackSmsStatus: "sent"',
  "fallbackSmsProviderMessageId",
  "a retry must not text",
  "VoiceTranscriptService.finalize",
  'type: "integration_failure"',
  'priority: "high"',
]);

const booking = requireAll(
  "src/services/booking/bookingStateMachine.service.js",
  [
    'channel = "sms"',
    'source = "booking_state_machine"',
    'channel === "voice" ? "voice" : "sms"',
    "bookingIdempotencyPrefix",
    "bookingEventPrefix",
    "channel: bookingChannel",
    "source: bookingSource",
    "source: bookingChannel",
    'bookedBy: "ai"',
    'bookingChannel !== "voice"',
  ],
);
if (!booking.includes('bookingChannel === "voice" ? "voice-" : ""')) {
  failures.push(
    "Voice appointment idempotency must be namespaced without changing existing SMS idempotency keys.",
  );
}

requireAll("src/routes/twilio.routes.js", [
  'router.post("/voice", validateTwilioSignature, VoiceWebhookController.initial)',
  'router.post("/voice-overflow"',
  'router.post("/voice-complete"',
  'router.post("/voice-transfer-complete"',
]);
requireAll("src/routes/voiceSettings.routes.js", [
  "router.use(checkAuth)",
  "VoiceSettingsController.get",
  "VoiceSettingsController.update",
  "VoiceSettingsController.readiness",
]);
requireAll("src/app.js", [
  "voiceSettingsRoutes",
  'app.use("/api/voice-settings", voiceSettingsRoutes)',
]);
requireAll("src/server.js", [
  "initializeConversationRelayServer",
  "initializeConversationRelayServer(httpServer)",
  "await conversationRelayServer.close()",
]);

const pkg = JSON.parse(read("package.json") || "{}");
if (!pkg.dependencies?.ws) failures.push("package.json is missing the ws dependency.");
if (!pkg.scripts?.["test:phase9"]) {
  failures.push("package.json is missing test:phase9.");
}

for (const relative of [
  "tests/unit/conversationRelay.server.test.js",
  "tests/unit/sendConfirmationSms.tool.test.js",
  "tests/unit/voiceAgent.service.test.js",
  "tests/unit/voiceRouting.service.test.js",
  "tests/unit/voiceSession.model.test.js",
  "tests/unit/voiceSessionFallback.service.test.js",
  "tests/unit/voiceSettings.controller.test.js",
  "tests/unit/voiceWebhook.controller.test.js",
  "tests/unit/voiceBookingStateMachineReuse.test.js",
]) {
  read(relative);
}

if (failures.length) {
  console.error("Phase 9 structure verification failed:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Phase 9 API structure verification passed.");
console.log(`Business voice settings: ${business ? "present" : "missing"}`);
console.log(`Voice session model: ${session ? "present" : "missing"}`);
console.log(`Voice webhook routing: ${webhook ? "present" : "missing"}`);
