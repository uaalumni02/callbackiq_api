#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const TARGETS = {
  lines: 85,
  statements: 85,
  functions: 80,
  branches: 75,
};

if (!fs.existsSync(summaryPath)) {
  console.error("FAIL: coverage/coverage-summary.json does not exist. Run npm run test:coverage first.");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const total = report.total;
if (!total) {
  console.error("FAIL: coverage summary does not contain a total record.");
  process.exit(1);
}

const failures = [];
console.log("\nCallBackIQ hard coverage targets:");
for (const [metric, target] of Object.entries(TARGETS)) {
  const item = total[metric];
  const pct = Number(item?.pct ?? 0);
  const covered = Number(item?.covered ?? 0);
  const count = Number(item?.total ?? 0);
  const targetCovered = Math.ceil((target / 100) * count);
  const gapUnits = Math.max(0, targetCovered - covered);
  const status = pct >= target ? "PASS" : "FAIL";
  console.log(
    `  ${status} ${metric.padEnd(10)} ${pct.toFixed(2)}% / ${target.toFixed(2)}%` +
      (gapUnits ? `  (${gapUnits} more covered units needed at current denominator)` : ""),
  );
  if (pct < target) failures.push({ metric, pct, target, gapUnits });
}

if (failures.length) {
  console.error("\nCoverage targets NOT reached.");
  console.error("Run: npm run coverage:targets:report");
  process.exit(1);
}

console.log("\nCoverage targets reached: lines/statements >=85%, functions >=80%, branches >=75%.");
