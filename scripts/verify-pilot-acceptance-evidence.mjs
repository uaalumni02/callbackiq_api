#!/usr/bin/env node
import fs from "node:fs";

const evidencePath =
  process.argv[2] || "docs/pilot-acceptance.evidence.json";

if (!fs.existsSync(evidencePath)) {
  console.error(`Missing pilot evidence file: ${evidencePath}`);
  console.error(
    "Copy docs/pilot-acceptance.example.json, fill it with real evidence, then rerun.",
  );
  process.exit(2);
}

const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const required = [
  "releaseShaApi",
  "releaseShaFrontend",
  "realInboundCall",
  "voiceAiOrMissedCallRouting",
  "smsDelivered",
  "qualificationPersisted",
  "urgentSafetyPath",
  "appointmentRequested",
  "appointmentApproved",
  "appointmentConfirmed",
  "calendarEventCreated",
  "cancelOrReschedule",
  "humanRequested",
  "staffTakeover",
  "stripeAccessState",
  "standaloneWorkerBoot",
  "apiReadiness",
  "operationalAlertObserved",
  "isolatedRestoreRehearsal",
];

const failures = [];

for (const key of required) {
  const item = evidence[key];

  if (["releaseShaApi", "releaseShaFrontend"].includes(key)) {
    if (!/^[a-f0-9]{7,40}$/i.test(String(item || ""))) {
      failures.push(`${key}: missing commit SHA`);
    }
    continue;
  }

  if (!item || item.passed !== true) {
    failures.push(`${key}: passed=true is required`);
  }
  if (!String(item?.evidence || "").trim()) {
    failures.push(`${key}: evidence text/link/id is required`);
  }
  if (
    !item?.observedAt ||
    Number.isNaN(new Date(item.observedAt).getTime())
  ) {
    failures.push(`${key}: valid observedAt is required`);
  }
}

if (failures.length) {
  console.error("REAL-WORLD PILOT ACCEPTANCE: FAIL");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("REAL-WORLD PILOT ACCEPTANCE: PASS");
console.log(`API SHA: ${evidence.releaseShaApi}`);
console.log(`Frontend SHA: ${evidence.releaseShaFrontend}`);
