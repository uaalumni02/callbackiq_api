import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["src/services/businessDeletion.service.js", "releaseTrackingNumber"],
  ["src/services/businessDeletion.service.js", "subscriptions.cancel"],
  ["src/services/trialIdentityVerification.service.js", "emailVerifiedAt"],
  ["src/services/trialIdentityVerification.service.js", "verificationChecks.create"],
  ["src/services/trialRisk.service.js", "reviewRequired"],
  ["src/services/trialTelecomGuard.service.js", "TWILIO_AUTOMATIC_NUMBER_PROVISIONING_ENABLED"],
  ["src/services/trackingNumberProvisioning.service.js", "TWILIO_PROVISIONING_BUDGET_ENABLED"],
  ["src/controllers/billing.js", "assertTrialIdentityVerified"],
  ["src/controllers/billing.js", "TRIAL_TURNSTILE_REQUIRED"],
  ["src/services/voiceUsage.service.js", "TRIAL_VOICE_DAILY_MINUTES"],
  ["src/services/voiceCapacity.service.js", "TRIAL_VOICE_MAX_CONCURRENT_CALLS"],
  ["src/services/trialLifecycle.service.js", "TRIAL_NO_PAYMENT_METHOD_NUMBER_RELEASE_GRACE_HOURS"],
  ["src/db/db.js", "deleteBusinessSafely"],
];

const failures = [];
for (const [file, needle] of checks) {
  const full = path.join(root, file);
  const text = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  if (!text.includes(needle)) failures.push(`${file}: missing ${needle}`);
}

if (failures.length) {
  console.error("Trial abuse hardening verification FAILED:");
  failures.forEach((item) => console.error(` - ${item}`));
  process.exit(1);
}

console.log("Trial abuse hardening structure verified.");
