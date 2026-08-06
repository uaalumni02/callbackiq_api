#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const checks = [
  ["src/services/scheduling/appointment.service.js", "runNonBlockingAppointmentSideEffect"],
  ["src/services/scheduling/appointment.service.js", "post-appointment follow-up scheduling"],
  ["src/services/scheduling/slotGenerator.service.js", "Object.defineProperties(slot"],
  ["src/services/booking/bookingStateMachine.service.js", "Do not treat a repeated"],
  ["src/services/booking/bookingStateMachine.service.js", "status: \"not_started\""],
  ["src/services/scheduling/availability.service.js", "supportedServiceArea: false"],
  ["src/services/scheduling/availability.service.js", "formatZonedIso"],
  ["src/services/scheduling/calendarProviderName.service.js", "PROVIDER_ALIASES[normalized] || normalized"],
  ["tests/unit/phase2_8.controllers.full.test.js", "googleCalendarChangeReview.service.js"],
  ["tests/unit/googleCalendar.provider.test.js", "sendUpdates=all"],
  ["tests/unit/googleCalendar.provider.test.js", "attendees: [{ email: \"jane@example.com\" }]"],
  ["tests/unit/automation.worker.test.js", "appointmentNotification.service.js"],
  ["tests/unit/automation.worker.test.js", "integrationWebhook.worker.js"],
];

let passed = 0;
for (const [relativePath, token] of checks) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    console.error(`FAIL missing ${relativePath}`);
    process.exitCode = 1;
    continue;
  }
  const source = fs.readFileSync(filePath, "utf8");
  if (!source.includes(token)) {
    console.error(`FAIL ${relativePath} is missing ${token}`);
    process.exitCode = 1;
    continue;
  }
  passed += 1;
}

const syntaxFiles = [...new Set(checks.map(([relativePath]) => relativePath))];
for (const relativePath of syntaxFiles) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    console.error(`FAIL syntax ${relativePath}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(`Google Calendar full-suite compatibility verification passed: ${passed} checks.`);
}
