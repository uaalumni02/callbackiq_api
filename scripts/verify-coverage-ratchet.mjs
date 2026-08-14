#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const policyPath = path.join(root, "config", "coverage-ratchet.json");
const update = process.argv.includes("--update");
const force = process.argv.includes("--force");

const fail = (message) => {
  console.error(`COVERAGE RATCHET FAIL: ${message}`);
  process.exitCode = 1;
};

if (!fs.existsSync(summaryPath)) {
  fail(`Missing ${path.relative(root, summaryPath)}. Run npm run test:coverage first.`);
  process.exit();
}
if (!fs.existsSync(policyPath)) {
  fail(`Missing ${path.relative(root, policyPath)}.`);
  process.exit();
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));

const metrics = ["branches", "functions", "lines", "statements"];
const pct = (record, metric) => Number(record?.[metric]?.pct ?? 0);
const normalizePath = (value) => value.split(path.sep).join("/");
const summaryEntries = Object.entries(summary);

const findRecord = (relativeFile) => {
  const normalizedWanted = normalizePath(relativeFile);
  for (const [key, value] of summaryEntries) {
    if (key === "total") continue;
    const normalized = normalizePath(key);
    if (
      normalized === normalizedWanted ||
      normalized.endsWith(`/${normalizedWanted}`)
    ) {
      return value;
    }
  }
  return null;
};

const violations = [];

const check = (scope, record, minimums) => {
  for (const metric of metrics) {
    const minimum = Number(minimums?.[metric] ?? 0);
    const actual = pct(record, metric);
    if (actual + 1e-9 < minimum) {
      violations.push(
        `${scope} ${metric}: ${actual.toFixed(2)}% < ${minimum.toFixed(2)}%`,
      );
    }
  }
};

check("global", summary.total, policy.policy?.globalMinimums || {});

for (const [relativeFile, minimums] of Object.entries(
  policy.criticalFiles || {},
)) {
  const record = findRecord(relativeFile);
  if (!record) {
    violations.push(`${relativeFile}: missing from coverage-summary.json`);
    continue;
  }
  check(relativeFile, record, minimums);
}

const targets = policy.policy?.targetMinimums || {};
const targetGaps = metrics
  .map((metric) => ({
    metric,
    actual: pct(summary.total, metric),
    target: Number(targets?.[metric] ?? 0),
  }))
  .filter(({ actual, target }) => target > 0 && actual + 1e-9 < target);

if (targetGaps.length) {
  console.log("\nCoverage target progress (informational; not a failing gate):");
  for (const { metric, actual, target } of targetGaps) {
    console.log(`  - ${metric}: ${actual.toFixed(2)}% / ${target.toFixed(2)}% target`);
  }
}

if (violations.length) {
  console.error("\nRisk-weighted coverage gate failed:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Risk-weighted coverage gate passed.");
}

if (update) {
  const next = structuredClone(policy);
  next.updatedAt = new Date().toISOString();

  for (const metric of metrics) {
    const actual = pct(summary.total, metric);
    const oldValue = Number(next.policy.globalMinimums?.[metric] ?? 0);
    next.policy.globalMinimums[metric] = Number(
      (force ? actual : Math.max(oldValue, actual)).toFixed(2),
    );
  }

  for (const relativeFile of Object.keys(next.criticalFiles || {})) {
    const record = findRecord(relativeFile);
    if (!record) continue;
    for (const metric of metrics) {
      const actual = pct(record, metric);
      const oldValue = Number(next.criticalFiles[relativeFile]?.[metric] ?? 0);
      next.criticalFiles[relativeFile][metric] = Number(
        (force ? actual : Math.max(oldValue, actual)).toFixed(2),
      );
    }
  }

  fs.writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `Updated ${path.relative(root, policyPath)} ${
      force ? "(forced current values)" : "(raise-only)"
    }.`,
  );
}
