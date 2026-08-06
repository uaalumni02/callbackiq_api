#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const availabilityPath = path.join(
  root,
  "src/services/scheduling/availability.service.js",
);
const controllerTestPath = path.join(
  root,
  "tests/unit/phase2_8.controllers.full.test.js",
);

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
};

for (const filePath of [availabilityPath, controllerTestPath]) {
  if (!fs.existsSync(filePath)) fail(`missing ${path.relative(root, filePath)}`);
}

if (!process.exitCode) {
  const availability = fs.readFileSync(availabilityPath, "utf8");
  const unsupportedBlock = availability.match(
    /if \(!serviceArea\.supported\) \{([\s\S]*?)\n    \}/,
  )?.[1];
  if (!unsupportedBlock) {
    fail("could not locate the unsupported service-area response");
  } else {
    for (const token of [
      "supportedServiceArea: false",
      "reason: serviceArea.reason",
      "provider: providerName",
      "slots: []",
    ]) {
      if (!unsupportedBlock.includes(token)) {
        fail(`unsupported service-area response is missing ${token}`);
      }
    }
    if (/\bserviceArea\s*,/.test(unsupportedBlock)) {
      fail("unsupported service-area response still exposes the extra serviceArea field");
    }
  }

  const testSource = fs.readFileSync(controllerTestPath, "utf8");
  for (const token of [
    '"../../src/services/scheduling/appointmentNotification.service.js"',
    "refreshUpcomingAppointmentNotifications: jest.fn()",
  ]) {
    if (!testSource.includes(token)) {
      fail(`controller test isolation is missing ${token}`);
    }
  }
}

for (const filePath of [availabilityPath, controllerTestPath]) {
  if (!fs.existsSync(filePath)) continue;
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    fail(`syntax ${path.relative(root, filePath)}`);
  }
}

if (!process.exitCode) {
  console.log(
    "Google Calendar final two-test compatibility verification passed: 8 checks.",
  );
}
