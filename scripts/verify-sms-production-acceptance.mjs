import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const mustExist = (relative) => {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) throw new Error(`Missing required SMS production file: ${relative}`);
  return full;
};

const requiredFiles = [
  "src/services/messaging/smsProductionInvariant.service.js",
  "tests/fixtures/smsProductionAcceptanceMatrix.js",
  "tests/unit/smsProductionAcceptanceMatrix.test.js",
  "docs/SMS_PRODUCTION_ACCEPTANCE.md",
];
requiredFiles.forEach(mustExist);

const invariant = read("src/services/messaging/smsProductionInvariant.service.js");
const processor = read("src/services/messaging/inboundSmsJobProcessor.service.js");
const eligibility = read("src/services/serviceEligibility/serviceEligibility.service.js");
const fixture = read("tests/fixtures/smsProductionAcceptanceMatrix.js");
const pkg = JSON.parse(read("package.json"));

const assertions = [
  [invariant.includes("CALLBACKIQ_SMS_PRODUCTION_INVARIANT_V1"), "production invariant marker"],
  [invariant.includes("removed_unverified_booking_commitment"), "booking commitment guard"],
  [invariant.includes("enforced_service_eligibility_boundary"), "service eligibility boundary"],
  [invariant.includes("added_scheduling_acknowledgement"), "multi-intent scheduling acknowledgement"],
  [processor.includes("applySmsProductionInvariants"), "processor integration"],
  [processor.includes("customerMessage: inboundMessage?.body"), "final send-path invariant invocation"],
  [eligibility.includes("Pricing and scheduling stay paused until staff confirms the service is accepted."), "staff review scheduling pause"],
  [Boolean(pkg.scripts?.["test:sms-production-acceptance"]), "production acceptance test script"],
  [Boolean(pkg.scripts?.["certify:sms-production"]), "production certification script"],
];
for (const [ok, label] of assertions) {
  if (!ok) throw new Error(`SMS production acceptance verification failed: ${label}`);
}

const lengths = [...fixture.matchAll(/Array\.from\(\{ length: (\d+)/g)].map((match) => Number(match[1]));
const total = lengths.reduce((sum, value) => sum + value, 0);
if (total < 75 || total > 150) {
  throw new Error(`SMS acceptance matrix must contain 75-150 cases; found ${total}`);
}

const categories = [
  "false_commitment",
  "known_fact_reask",
  "unsupported_service",
  "staff_review_boundary",
  "multi_intent",
  "callback_continuity",
  "safe_ambiguity",
  "safety_dedupe",
];
for (const category of categories) {
  if (!fixture.includes(`category: "${category}"`)) {
    throw new Error(`SMS acceptance matrix missing category: ${category}`);
  }
}

console.log(`SMS production acceptance structure verified (${total} fixed cases).`);
