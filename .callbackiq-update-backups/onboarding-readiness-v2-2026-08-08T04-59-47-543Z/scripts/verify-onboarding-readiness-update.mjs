import fs from "fs";
import path from "path";

const root = process.cwd();
const checks = [
  ["src/models/business.js", "trackingNumber:"],
  ["src/models/business.js", "setupProgress:"],
  ["src/models/business.js", "unique: true, sparse: true"],
  ["src/controllers/auth.js", "forwardingPhone: normalizedForwardingPhone"],
  ["src/controllers/auth.js", 'status: "unassigned"'],
  ["src/services/businessReadiness.service.js", "bookingConfigurationReady"],
  ["src/services/businessReadiness.service.js", "aiBookingPermissionConfigured"],
  ["src/services/trackingNumberProvisioning.service.js", "provisionTrackingNumber"],
  ["src/routes/customerRecovery.routes.js", "recovery-detail"],
  ["src/routes/business.routes.js", "/mine/readiness"],
  ["src/routes/business.routes.js", "/mine/tracking-number/provision"],
  ["src/app.js", 'app.use("/api/customers", customerRecoveryRoutes);'],
  ["src/services/twilioBusinessResolver.service.js", '"trackingNumber.status": "active"'],
  ["src/services/twilioSmsWebhook.service.js", "TWILIO_NUMBER_NOT_MAPPED"],
  ["src/controllers/voiceWebhook.js", "TWILIO_NUMBER_NOT_MAPPED"],
  ["src/models/lead.js", "customerLifecycleStatus"],
  ["src/models/conversation.js", "customerLifecycleStatus"],
  ["src/models/appointment.js", "customerLifecycleStatus"],
  ["src/models/voiceSession.js", "customerLifecycleStatus"],
  ["src/models/alert.js", "customerLifecycleStatus"],
];

const forbidden = [
  [
    "src/controllers/auth.js",
    "phone: normalizedBusinessPhone",
    "registration still writes the owner-entered phone into Business.phone",
  ],
  [
    "src/pages/Register.js",
    "Business Phone",
    "frontend-only check accidentally ran in API repo",
  ],
];

const failures = [];
for (const [file, needle] of checks) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    failures.push(`${file} is missing`);
    continue;
  }
  const text = fs.readFileSync(full, "utf8");
  if (!text.includes(needle)) failures.push(`${file} is missing: ${needle}`);
}

for (const [file, needle, reason] of forbidden) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  if (text.includes(needle)) failures.push(`${file}: ${reason}`);
}

if (failures.length) {
  console.error("CallBackIQ onboarding/readiness verification failed:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`CallBackIQ onboarding/readiness verification passed: ${checks.length} positive checks.`);
