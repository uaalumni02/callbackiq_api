#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const outputPath = path.join(root, "coverage", "risk-report.json");

if (!fs.existsSync(summaryPath)) {
  console.error("COVERAGE RISK REPORT FAIL: coverage/coverage-summary.json is missing. Run npm run test:coverage first.");
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const normalize = (value) => String(value || "").replaceAll("\\", "/");
const pct = (record, metric) => Number(record?.[metric]?.pct ?? 0);

const classify = (file) => {
  const f = file.toLowerCase();
  if (/(billing|subscription|stripe|invoice|payment|trialredemption|triallifecycle)/.test(f)) {
    return { category: "money/entitlement", weight: 5 };
  }
  if (/(twilio|a2p|sms|voice|communicationusage)/.test(f)) {
    return { category: "telecom/cost-control", weight: 5 };
  }
  if (/(auth|signature|access|socket-auth|permission|security)/.test(f)) {
    return { category: "security", weight: 5 };
  }
  if (/(googlecalendar|jobber|integration|webhook)/.test(f)) {
    return { category: "external-integration", weight: 4 };
  }
  if (/(ai|openai|guardrail|qualifylead|followupagent)/.test(f)) {
    return { category: "ai-boundary", weight: 4 };
  }
  if (/(worker|queue|maintenance|reconcile|backfill|migration|script)/.test(f)) {
    return { category: "async/maintenance", weight: 3 };
  }
  return { category: "general", weight: 1 };
};

const rows = [];
for (const [rawFile, record] of Object.entries(summary)) {
  if (rawFile === "total") continue;
  const normalized = normalize(rawFile);
  const srcIndex = normalized.lastIndexOf("/src/");
  const file = srcIndex >= 0 ? normalized.slice(srcIndex + 1) : normalized.replace(/^.*?(src\/)/, "$1");
  if (!file.startsWith("src/")) continue;

  const lines = pct(record, "lines");
  const functions = pct(record, "functions");
  const branches = pct(record, "branches");
  const totalLines = Number(record?.lines?.total ?? 0);
  const totalFunctions = Number(record?.functions?.total ?? 0);
  const coveredFunctions = Number(record?.functions?.covered ?? 0);
  const { category, weight } = classify(file);
  const uncoveredSeverity = (100 - branches) * 0.5 + (100 - lines) * 0.3 + (100 - functions) * 0.2;
  const surfaceMultiplier = Math.max(1, Math.log10(Math.max(10, totalLines)));
  const score = Number((weight * uncoveredSeverity * surfaceMultiplier).toFixed(2));
  const flags = [];
  if (totalFunctions > 0 && coveredFunctions === 0) flags.push("loaded-never-exercised");
  if (branches < 50) flags.push("branch-risk");
  if (lines < 50) flags.push("low-direct-coverage");
  if (totalLines >= 500 && lines < 75) flags.push("large-low-coverage-surface");

  rows.push({
    file,
    category,
    riskWeight: weight,
    score,
    coverage: { lines, functions, branches },
    totals: { lines: totalLines, functions: totalFunctions },
    flags,
  });
}

rows.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
const report = {
  generatedAt: new Date().toISOString(),
  source: "fresh coverage/coverage-summary.json",
  methodology: {
    score: "riskWeight * (50% uncovered branches + 30% uncovered lines + 20% uncovered functions) * log10(source lines)",
    categories: {
      "money/entitlement": 5,
      "telecom/cost-control": 5,
      security: 5,
      "external-integration": 4,
      "ai-boundary": 4,
      "async/maintenance": 3,
      general: 1,
    },
    note: "Ranking is prioritization guidance, not a substitute for domain review or per-file ratchet gates.",
  },
  total: summary.total,
  topRisks: rows.slice(0, 50),
  allFiles: rows,
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log("\nCoverage risk ranking (top 20):");
for (const [index, row] of rows.slice(0, 20).entries()) {
  const flags = row.flags.length ? ` [${row.flags.join(", ")}]` : "";
  console.log(
    `${String(index + 1).padStart(2, " ")}. ${row.file} — ${row.category} — score ${row.score.toFixed(2)} — ` +
      `L ${row.coverage.lines.toFixed(1)} / B ${row.coverage.branches.toFixed(1)} / F ${row.coverage.functions.toFixed(1)}${flags}`,
  );
}
console.log(`\nWrote ${path.relative(root, outputPath)} for the CI coverage artifact.`);
