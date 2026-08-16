#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const summaryPath = path.join(process.cwd(), "coverage", "coverage-summary.json");
if (!fs.existsSync(summaryPath)) {
  console.error("coverage/coverage-summary.json missing. Run npm run test:coverage first.");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const targets = { lines: 85, statements: 85, functions: 80, branches: 75 };
const normalize = (name) =>
  name.replaceAll("\\", "/").replace(`${process.cwd().replaceAll("\\", "/")}/`, "");

const unitGap = (entry, metric, target) => {
  const item = entry?.[metric];
  if (!item || !Number(item.total)) return 0;
  return Math.max(0, Math.ceil((target / 100) * item.total) - item.covered);
};

console.log("\nGlobal target gaps:");
for (const [metric, target] of Object.entries(targets)) {
  const item = report.total[metric];
  const need = Math.max(0, Math.ceil((target / 100) * item.total) - item.covered);
  console.log(
    `  ${metric.padEnd(10)} ${Number(item.pct).toFixed(2)}% -> ${target}% | ` +
      `${item.covered}/${item.total} | +${need} covered units needed`,
  );
}

const rows = Object.entries(report)
  .filter(([name]) => name !== "total" && normalize(name).includes("src/"))
  .map(([name, entry]) => ({
    file: normalize(name),
    linesPct: Number(entry.lines?.pct ?? 100),
    funcsPct: Number(entry.functions?.pct ?? 100),
    branchPct: Number(entry.branches?.pct ?? 100),
    missingLines: Number(entry.lines?.total ?? 0) - Number(entry.lines?.covered ?? 0),
    missingFunctions:
      Number(entry.functions?.total ?? 0) - Number(entry.functions?.covered ?? 0),
    missingBranches:
      Number(entry.branches?.total ?? 0) - Number(entry.branches?.covered ?? 0),
  }))
  .map((row) => ({
    ...row,
    score: row.missingLines + row.missingFunctions * 8 + row.missingBranches * 3,
  }))
  .sort((a, b) => b.score - a.score);

console.log("\nHighest remaining leverage (missing executable units, not just percentages):");
for (const row of rows.slice(0, 30)) {
  console.log(
    `  ${row.file}\n` +
      `    lines ${row.linesPct.toFixed(1)}% (-${row.missingLines}) | ` +
      `funcs ${row.funcsPct.toFixed(1)}% (-${row.missingFunctions}) | ` +
      `branches ${row.branchPct.toFixed(1)}% (-${row.missingBranches})`,
  );
}

const targetFiles = [
  "src/services/bookingEligibility.service.js",
  "src/services/businessConfiguration.service.js",
  "src/services/voiceUsage.service.js",
  "src/services/integrations/googleCalendarSync.service.js",
  "src/workers/integrationMaintenance.worker.js",
  "src/controllers/twilio.js",
  "src/services/a2pCustomerOnboarding.service.js",
];
console.log("\nTarget-lift files after this wave:");
for (const wanted of targetFiles) {
  const found = Object.entries(report).find(([name]) => normalize(name).endsWith(wanted));
  if (!found) {
    console.log(`  MISSING FROM REPORT: ${wanted}`);
    continue;
  }
  const [, e] = found;
  console.log(
    `  ${wanted}: lines ${e.lines.pct}% | functions ${e.functions.pct}% | branches ${e.branches.pct}%`,
  );
}
