import fs from "node:fs";
const checks = [
  ["src/voice/voiceOutcome.service.js", "recoverAbandonedVoiceCall"],
  ["src/voice/voiceUnderstanding.service.js", "classifyVoiceTurn"],
  ["src/voice/voiceMetrics.service.js", "getVoicePilotMetrics"],
  ["src/voice/voiceExistingJobStatus.service.js", "lookupExistingVoiceAppointment"],
  ["src/voice/voicePreflight.service.js", "checkVoicePreflight"],
  ["src/voice/conversationRelay.server.js", "DEFAULT_SOFT_TURN_TIMEOUT_MS = 2_500"],
  ["src/voice/conversationRelay.server.js", "recoverAbandonedVoiceCall"],
  ["src/voice/voiceRouting.service.js", "automated assistant"],
  ["src/voice/voiceRouting.service.js", "Still there? Press 1"],
  ["src/controllers/voiceWebhook.js", "checkVoicePreflight"],
  ["src/controllers/voiceWebhook.js", "phoneLookup: e164"],
  ["src/models/voiceSession.js", "outcomeCommittedAt"],
  ["src/routes/voiceOperations.routes.js", 'router.get("/metrics"'],
  ["src/routes/voiceOperations.routes.js", 'router.post("/metrics/emergency-review"'],
  ["src/controllers/voiceWebhook.js", "Business.findOne({ isActive: true, phoneLookup: e164 })"],
  ["src/voice/voiceRouting.service.js", "getConversationRelayLanguage"],
];
const failures = [];
for (const [file, token] of checks) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!text.includes(token)) failures.push(`${file} is missing ${token}`);
}
if (failures.length) {
  console.error(`Voice pilot verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Voice pilot verification passed: ${checks.length} checks.`);
