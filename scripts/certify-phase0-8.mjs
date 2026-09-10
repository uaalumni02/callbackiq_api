#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const requestedPhase = [...args]
  .find((arg) => arg.startsWith("--phase="))
  ?.split("=")[1];
const includeLive = args.has("--include-live");
const listOnly = args.has("--list");

const phaseGroups = {
  "0": {
    name: "Foundation",
    tests: [
      "tests/unit/businessFeatures.test.js",
      "tests/unit/twilioEventKey.test.js",
      "tests/integration/contactPreference.service.test.js",
      "tests/integration/twilioWebhookEvent.service.test.js",
      "tests/integration/twilioWebhookIdempotency.test.js",
      "tests/integration/twilioOptOut.test.js",
      "tests/integration/businessFeatures.test.js",
      "tests/integration/providerUniqueIndexes.test.js",
      "tests/routes/twilio.routes.test.js",
      "tests/unit/aiReplyBookingSafety.test.js",
      "tests/routes/business.routes.test.js",
      "tests/routes/dashboard.routes.test.js",
      "tests/routes/alert.routes.test.js",
    ],
  },
  "1": {
    name: "Business configuration",
    tests: [
      "tests/routes/businessConfiguration.routes.test.js",
      "tests/services/bookingEligibility.service.test.js",
      "tests/completion/phase0-2.contract.test.js",
    ],
  },
  "2": {
    name: "Appointment engine",
    tests: [
      "tests/unit/timezone.service.test.js",
      "tests/unit/postalCodeDistance.service.test.js",
      "tests/unit/appointmentPolicy.service.test.js",
      "tests/unit/appointmentPolicy.completion.test.js",
      "tests/unit/appointment.service.test.js",
      "tests/unit/internalScheduling.provider.test.js",
      "tests/unit/slotGenerator.service.test.js",
      "tests/unit/availability.service.test.js",
      "tests/unit/schedulingProvider.test.js",
      "tests/unit/schedulingProviderFactory.test.js",
      "tests/unit/unsupportedSchedulingProviders.test.js",
      "tests/integration/appointmentEngine.test.js",
    ],
  },
  "3": {
    name: "Google Calendar contract",
    tests: [
      "tests/unit/integrationSettings.test.js",
      "tests/unit/googleCalendar.provider.test.js",
      "tests/unit/googleCalendarProvider.test.js",
      "tests/unit/googleCalendarConnection.service.full.test.js",
      "tests/unit/tokenEncryption.service.test.js",
      "tests/unit/integrationWebhookSignature.test.js",
    ],
    liveScript: "verify:phase3:google",
  },
  "4": {
    name: "AI booking",
    tests: [
      "tests/unit/aiBookingTools.test.js",
      "tests/unit/aiReplyBookingSafety.test.js",
      "tests/unit/aiReplyService.full.test.js",
      "tests/unit/bookingStateMachine.service.full.test.js",
      "tests/integration/aiBookingConversationMatrix.completion.test.js",
      "tests/unit/googleCalendar.provider.test.js",
    ],
  },
  "5": {
    name: "Automated follow-up",
    tests: [
      "tests/unit/automation.service.test.js",
      "tests/unit/automation.worker.test.js",
      "tests/unit/automationTrigger.service.test.js",
      "tests/middleware/inboundSmsLifecycle.test.js",
      "tests/middleware/missedCallAutomationLifecycle.test.js",
    ],
  },
  "6": {
    name: "Revenue analytics",
    tests: [
      "tests/unit/conversionEvent.service.test.js",
      "tests/unit/revenueRecovery.service.test.js",
      "tests/unit/revenueRecovery.completion.test.js",
      "tests/routes/dashboard.routes.test.js",
    ],
  },
  "7": {
    name: "Intervention Center",
    tests: [
      "tests/unit/intervention.service.test.js",
      "tests/controllers/intervention.completion.test.js",
      "tests/controllers/intervention.audit.completion.test.js",
      "tests/unit/phase2_8.controllers.full.test.js",
      "tests/unit/socket.service.branch.full.test.js",
      "tests/middleware/socket-auth.full.test.js",
      "tests/integration/interventionSocketDelivery.completion.test.js",
      "tests/validators/alert.intervention.completion.test.js",
    ],
  },
  "8": {
    name: "Jobber contract",
    tests: [
      "tests/unit/jobber.provider.test.js",
      "tests/unit/jobberConnection.service.full.test.js",
      "tests/unit/jobberOAuth.service.full.test.js",
      "tests/unit/external-clients.full.test.js",
      "tests/unit/tokenEncryption.service.test.js",
      "tests/unit/integrationWebhookSignature.test.js",
    ],
    liveScript: "verify:phase8:jobber",
  },
};

const selectedEntries = Object.entries(phaseGroups).filter(([phase]) =>
  requestedPhase ? phase === requestedPhase : true,
);

if (selectedEntries.length === 0) {
  console.error(`Unknown phase: ${requestedPhase}`);
  process.exit(2);
}

const missing = selectedEntries.flatMap(([phase, group]) =>
  group.tests
    .filter((file) => !fs.existsSync(path.join(root, file)))
    .map((file) => ({ phase, file })),
);

if (listOnly) {
  for (const [phase, group] of selectedEntries) {
    console.log(`Phase ${phase} — ${group.name}`);
    for (const test of group.tests) console.log(`  ${test}`);
    if (group.liveScript) console.log(`  live: npm run ${group.liveScript}`);
  }
  process.exit(missing.length ? 1 : 0);
}

if (missing.length) {
  console.error("Certification cannot start because required tests are missing:");
  for (const entry of missing) {
    console.error(`  Phase ${entry.phase}: ${entry.file}`);
  }
  process.exit(1);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const report = {
  startedAt: new Date().toISOString(),
  root,
  includeLive,
  phases: [],
};

const run = (command, commandArgs) =>
  spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });

for (const [phase, group] of selectedEntries) {
  console.log(`\n=== Phase ${phase}: ${group.name} ===`);
  const startedAt = new Date().toISOString();
  const result = run(npm, ["exec", "--", "jest", ...group.tests, "--runInBand"]);
  const phaseResult = {
    phase: Number(phase),
    name: group.name,
    startedAt,
    completedAt: new Date().toISOString(),
    code: result.status ?? 1,
    localContractPassed: result.status === 0,
    liveVerification: group.liveScript ? "not_requested" : "not_applicable",
  };

  if (result.status !== 0) {
    report.phases.push(phaseResult);
    report.completedAt = new Date().toISOString();
    report.passed = false;
    fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "artifacts", "phase0-8-certification.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    process.exit(result.status || 1);
  }

  if (includeLive && group.liveScript) {
    console.log(`\n--- Live verification: ${group.liveScript} ---`);
    const liveResult = run(npm, ["run", group.liveScript]);
    phaseResult.liveVerification = liveResult.status === 0 ? "passed" : "failed";
    if (liveResult.status !== 0) {
      report.phases.push(phaseResult);
      report.completedAt = new Date().toISOString();
      report.passed = false;
      fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "artifacts", "phase0-8-certification.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      process.exit(liveResult.status || 1);
    }
  }

  report.phases.push(phaseResult);
}

report.completedAt = new Date().toISOString();
report.passed = true;
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(
  path.join(root, "artifacts", "phase0-8-certification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log("\nAll selected code-level phase certifications passed.");
if (!includeLive && !requestedPhase) {
  console.log(
    "Google Calendar and Jobber live-account verification remain intentionally separate. Run with --include-live after credentials and connected accounts are available.",
  );
}
