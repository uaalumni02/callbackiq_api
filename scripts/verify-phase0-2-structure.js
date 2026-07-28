import fs from "fs";
import path from "path";

const root = process.cwd();
const required = [
  "src/models/business.js",
  "src/models/message.js",
  "src/models/callLog.js",
  "src/models/serviceOffering.js",
  "src/models/availabilityRule.js",
  "src/models/availabilityException.js",
  "src/models/schedulingPolicy.js",
  "src/models/serviceArea.js",
  "src/models/businessOperationsSettings.js",
  "src/models/appointment.js",
  "src/controllers/businessConfiguration.js",
  "src/routes/businessConfiguration.routes.js",
  "src/routes/availability.routes.js",
  "src/routes/appointment.routes.js",
  "src/services/bookingEligibility.service.js",
  "src/services/scheduling/appointment.service.js",
  "src/services/scheduling/availability.service.js",
  "src/services/scheduling/appointmentPolicy.service.js",
  "src/services/scheduling/slotGenerator.service.js",
  "src/services/scheduling/timezone.service.js",
  "src/services/scheduling/schedulingProviderFactory.js",
  "src/integrations/scheduling/schedulingProvider.js",
  "src/integrations/scheduling/internalScheduling.provider.js",
  "scripts/ensure-phase0-provider-indexes.js",
  "tests/integration/twilioWebhookIdempotency.test.js",
  "tests/integration/twilioOptOut.test.js",
  "tests/integration/providerUniqueIndexes.test.js",
  "tests/routes/businessConfiguration.routes.test.js",
  "tests/services/bookingEligibility.service.test.js",
  "tests/integration/appointmentEngine.test.js",
  "tests/unit/timezone.service.test.js",
  "tests/unit/appointmentPolicy.service.test.js",
  "tests/unit/appointment.service.test.js",
  "tests/unit/internalScheduling.provider.test.js",
  "tests/unit/slotGenerator.service.test.js",
  "tests/completion/phase0-2.contract.test.js",
];

const missing = required.filter(
  (relativePath) => !fs.existsSync(path.join(root, relativePath)),
);

if (missing.length) {
  console.error("Phase 0-2 structure verification failed. Missing files:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const packagePath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const requiredScripts = [
  "ensure:phase0:indexes",
  "test:phase0",
  "test:phase1",
  "test:phase2",
  "test:phase0-2:completion",
];
for (const script of requiredScripts) {
  if (!pkg.scripts?.[script]) {
    console.error(`Phase 0-2 structure verification failed: missing npm script ${script}`);
    process.exit(1);
  }
}

console.log("Phase 0-2 structure verification passed.");
console.log(`Verified ${required.length} required files and ${requiredScripts.length} npm scripts.`);
