#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { providerContractGroups } from "../tests/e2e/productionJourney.manifest.js";

const root = process.cwd();

const inertProviderEnvironment = () => ({
  ...process.env,
  NODE_ENV: "test",
  TZ: "UTC",
  CALLBACKIQ_CERTIFICATION_MODE: "deterministic",
  CALLBACKIQ_DISABLE_EXTERNAL_WRITES: "1",

  // These intentionally replace any developer/live credentials inherited
  // from .env or the shell. The Jest network guard is an additional barrier.
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
});

const tests = Array.from(
  new Set(providerContractGroups.flatMap((group) => group.tests)),
);

const missing = tests.filter(
  (relativePath) => !fs.existsSync(path.join(root, relativePath)),
);

if (missing.length) {
  console.error("\nProvider-contract certification cannot start.");
  console.error("Missing expected test files:");
  for (const file of missing) console.error(`  - ${file}`);
  process.exit(1);
}

console.log("\nCallBackIQ provider contract certification");
console.log("Live external-provider networking: BLOCKED\n");

for (const group of providerContractGroups) {
  console.log(`• ${group.name}`);
  for (const file of group.tests) console.log(`    ${file}`);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npx,
  [
    "jest",
    "tests/unit/externalProviderSafety.test.js",
    ...tests,
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

process.exit(result.status ?? 1);
