import fs from "node:fs";
import path from "node:path";

const summaryPath = path.resolve("coverage/coverage-summary.json");
const requiredMetrics = ["branches", "functions", "lines", "statements"];

if (!fs.existsSync(summaryPath)) {
  console.error("Coverage summary not found. Run npm run test:coverage first.");
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const failures = [];

for (const metric of requiredMetrics) {
  const percent = Number(summary.total?.[metric]?.pct ?? 0);
  if (percent !== 100) failures.push(`${metric}: ${percent}%`);
}

if (failures.length > 0) {
  console.error(`Coverage is below 100% (${failures.join(", ")}).`);
  process.exit(1);
}

console.log("Coverage verified: 100% branches, functions, lines, and statements.");
