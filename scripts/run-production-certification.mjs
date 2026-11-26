#!/usr/bin/env node
import {verificationEnvironment} from './check.mjs';
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  allCertificationTests,
  certificationStages,
  providerContractGroups,
} from "../tests/e2e/productionJourney.manifest.js";

const root = process.cwd();

const inertProviderEnvironment = () => ({...verificationEnvironment('callbackiq_api'),TZ:'UTC'});

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
    "--maxWorkers=1",
    "--workerIdleMemoryLimit=512MB",
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
