#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  allCertificationTests,
  certificationStages,
  providerContractGroups,
} from "../tests/e2e/productionJourney.manifest.js";

const root = process.cwd();

const inertProviderEnvironment = () => ({
  ...process.env,
  NODE_ENV: "test",
  TZ: "UTC",
  CALLBACKIQ_CERTIFICATION_MODE: "deterministic",
  CALLBACKIQ_DISABLE_EXTERNAL_WRITES: "1",
  CALLBACKIQ_TEST_EXTERNAL_PROVIDER_NETWORK: "blocked",

  /*
   * Never inherit live provider credentials into the certification child
   * process. These are syntactically plausible but intentionally inert test
   * placeholders. Even if a provider SDK is accidentally constructed, the
   * global Jest network guard prevents the request from leaving the process.
   */
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "callbackiq_test_auth_token",
  TWILIO_API_KEY: "SK00000000000000000000000000000000",
  TWILIO_API_SECRET: "callbackiq_test_api_secret",
  TWILIO_MESSAGING_SERVICE_SID: "MG00000000000000000000000000000000",
  STRIPE_SECRET_KEY: "sk_test_callbackiq_certification_only",
  STRIPE_WEBHOOK_SECRET: "whsec_callbackiq_certification_only",
  OPENAI_API_KEY: "inert-openai-test-certification-only",
  GOOGLE_CLIENT_ID: "callbackiq-certification.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "callbackiq-certification-secret",
  RESEND_API_KEY: "re_test_callbackiq_certification_only",
});

const tests = [
  "tests/unit/externalProviderSafety.test.js",
  "tests/e2e/productionJourney.certification.test.js",
  ...allCertificationTests(),
];

const uniqueTests = Array.from(new Set(tests));
const missing = uniqueTests.filter(
  (relativePath) => !fs.existsSync(path.join(root, relativePath)),
);

if (missing.length) {
  console.error("\nProduction certification cannot start.");
  console.error(
    "The manifest references files that are missing from this checkout:",
  );
  for (const file of missing) console.error(`  - ${file}`);
  console.error(
    "\nUpdate tests/e2e/productionJourney.manifest.js only if a suite was intentionally renamed or replaced.",
  );
  process.exit(1);
}

console.log("\n============================================================");
console.log(" CallBackIQ deterministic production certification");
console.log("============================================================");
console.log("External provider network access : BLOCKED");
console.log("Live Twilio number purchasing    : IMPOSSIBLE from Jest");
console.log("Live A2P submission              : IMPOSSIBLE from Jest");
console.log("Live Stripe/OpenAI/Google calls  : BLOCKED");
console.log("Staging mutations                : NOT RUN by this command");
console.log("Timezone                         : UTC");
console.log("============================================================\n");

console.log("Customer-journey coverage:");
for (const stage of certificationStages) {
  console.log(`  • ${stage.name}`);
}

console.log("\nProvider contracts:");
for (const group of providerContractGroups) {
  console.log(`  • ${group.name}`);
}

console.log(`\nRunning ${uniqueTests.length} unique certification suites...\n`);

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npx,
  [
    "jest",
    ...uniqueTests,
    "--runInBand",
    "--no-cache",
    "--verbose",
  ],
  {
    cwd: root,
    env: inertProviderEnvironment(),
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("\n============================================================");
console.log(" Production certification: PASS");
console.log("============================================================");
for (const stage of certificationStages) {
  console.log(`✓ ${stage.name}`);
}
for (const group of providerContractGroups) {
  console.log(`✓ ${group.name} provider contracts`);
}
console.log("============================================================\n");
