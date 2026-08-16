#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const policyPath = path.join(root, "config", "coverage-ratchet.json");
const update = process.argv.includes("--update");
const rebaseline = process.argv.includes("--rebaseline");
const metrics = ["branches", "functions", "lines", "statements"];
const EPSILON = 1e-9;

const die = (message) => {
  console.error(`COVERAGE RATCHET FAIL: ${message}`);
  process.exit(1);
};

if (update && rebaseline) {
  die("Choose either --update (raise-only) or --rebaseline, not both.");
}
if (!fs.existsSync(summaryPath)) {
  die(`Missing ${path.relative(root, summaryPath)}. Run npm run test:coverage first.`);
}
if (!fs.existsSync(policyPath)) {
  die(`Missing ${path.relative(root, policyPath)}.`);
}

let summary;
let policy;
try {
  summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
} catch (error) {
  die(`Unable to parse coverage policy/summary JSON: ${error.message}`);
}

const normalizePath = (value) => String(value || "").split(path.sep).join("/");
const summaryEntries = Object.entries(summary || {});
const pct = (record, metric) => Number(record?.[metric]?.pct ?? 0);
const validPercent = (value) => Number.isFinite(value) && value >= 0 && value <= 100;

const findRecord = (relativeFile) => {
  const wanted = normalizePath(relativeFile);
  for (const [key, value] of summaryEntries) {
    if (key === "total") continue;
    const normalized = normalizePath(key);
    if (normalized === wanted || normalized.endsWith(`/${wanted}`)) return value;
  }
  return null;
};

const configErrors = [];
const validateMinimums = (scope, minimums) => {
  for (const metric of metrics) {
    const value = Number(minimums?.[metric] ?? 0);
    if (!validPercent(value)) {
      configErrors.push(`${scope} ${metric}: invalid minimum ${minimums?.[metric]}`);
    }
  }
};

validateMinimums("global", policy.policy?.globalMinimums || {});
for (const [relativeFile, minimums] of Object.entries(policy.criticalFiles || {})) {
  validateMinimums(relativeFile, minimums);
  const sourcePath = path.join(root, relativeFile);
  if (!fs.existsSync(sourcePath)) {
    configErrors.push(`${relativeFile}: policy references a source file that does not exist`);
  }
}
for (const [name, minimums] of Object.entries(policy.criticalTargets || {})) {
  validateMinimums(`criticalTargets.${name}`, minimums);
}
validateMinimums("targetMinimums", policy.policy?.targetMinimums || {});

if (!summary?.total) configErrors.push("coverage-summary.json is missing the total record");

if (configErrors.length) {
  console.error("\nCoverage policy configuration errors:");
  for (const error of configErrors) console.error(`  - ${error}`);
  process.exit(1);
}

const violations = [];
const check = (scope, record, minimums) => {
  for (const metric of metrics) {
    const minimum = Number(minimums?.[metric] ?? 0);
    const actual = pct(record, metric);
    if (!validPercent(actual)) {
      violations.push(`${scope} ${metric}: invalid measured value ${actual}`);
      continue;
    }
    if (actual + EPSILON < minimum) {
      violations.push(
        `${scope} ${metric}: ${actual.toFixed(2)}% < ${minimum.toFixed(2)}%`,
      );
    }
  }
};

check("global", summary.total, policy.policy?.globalMinimums || {});
for (const [relativeFile, minimums] of Object.entries(policy.criticalFiles || {})) {
  const record = findRecord(relativeFile);
  if (!record) {
    violations.push(`${relativeFile}: missing from freshly generated coverage-summary.json`);
    continue;
  }
  check(relativeFile, record, minimums);
}

const targetMinimums = policy.policy?.targetMinimums || {};
const targetGaps = metrics
  .map((metric) => ({
    metric,
    actual: pct(summary.total, metric),
    target: Number(targetMinimums?.[metric] ?? 0),
  }))
  .filter(({ actual, target }) => target > 0 && actual + EPSILON < target);

if (targetGaps.length) {
  console.log("\nCoverage target progress (informational; not a failing gate):");
  for (const { metric, actual, target } of targetGaps) {
    console.log(`  - ${metric}: ${actual.toFixed(2)}% / ${target.toFixed(2)}% target`);
  }
}

const watch = policy.riskWatchFiles || {};
if (Object.keys(watch).length) {
  console.log("\nHigh-risk coverage watchlist (informational until promoted to criticalFiles):");
  for (const [relativeFile, config] of Object.entries(watch)) {
    const record = findRecord(relativeFile);
    const exists = fs.existsSync(path.join(root, relativeFile));
    if (!exists) {
      console.log(`  - ${relativeFile}: source absent on this revision (stale watch entry)`);
      continue;
    }
    if (!record) {
      console.log(`  - ${relativeFile}: source exists but is missing from coverage output`);
      continue;
    }
    const target = config?.target || policy.criticalTargets?.moneyTelecomEntitlement || {};
    const progress = metrics
      .map((metric) => `${metric} ${pct(record, metric).toFixed(1)}/${Number(target?.[metric] ?? 0).toFixed(0)}`)
      .join(", ");
    console.log(`  - ${relativeFile}: ${progress}`);
  }
}

if (violations.length) {
  console.error("\nRisk-weighted coverage gate failed:");
  for (const violation of violations) console.error(`  - ${violation}`);

  if (update) {
    console.error(
      "\nRefusing --update while coverage is below an existing floor. Add tests or use the explicitly gated --rebaseline escape hatch for a documented stale baseline.",
    );
    process.exit(1);
  }
  if (!rebaseline) process.exit(1);
  console.error(
    "\nProceeding only because --rebaseline was explicitly requested; the environment/reason guard below must still pass.",
  );
} else {
  console.log("Risk-weighted coverage gate passed.");
}

if (update) {
  const next = structuredClone(policy);
  next.updatedAt = new Date().toISOString();
  next.lastUpdateMode = "raise-only";

  for (const metric of metrics) {
    const actual = pct(summary.total, metric);
    const oldValue = Number(next.policy.globalMinimums?.[metric] ?? 0);
    next.policy.globalMinimums[metric] = Number(Math.max(oldValue, actual).toFixed(2));
  }

  for (const relativeFile of Object.keys(next.criticalFiles || {})) {
    const record = findRecord(relativeFile);
    if (!record) continue;
    for (const metric of metrics) {
      const actual = pct(record, metric);
      const oldValue = Number(next.criticalFiles[relativeFile]?.[metric] ?? 0);
      next.criticalFiles[relativeFile][metric] = Number(
        Math.max(oldValue, actual).toFixed(2),
      );
    }
  }

  fs.writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, policyPath)} (raise-only).`);
}

if (rebaseline) {
  const allowed = process.env.ALLOW_COVERAGE_REBASELINE === "1";
  const reason = String(process.env.COVERAGE_REBASELINE_REASON || "").trim();
  if (!allowed || reason.length < 8) {
    die(
      "Rebaseline requires ALLOW_COVERAGE_REBASELINE=1 and a non-trivial COVERAGE_REBASELINE_REASON.",
    );
  }

  const next = structuredClone(policy);
  next.updatedAt = new Date().toISOString();
  next.lastUpdateMode = "explicit-rebaseline";
  next.lastRebaseline = {
    at: next.updatedAt,
    reason,
    actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown",
  };

  for (const metric of metrics) {
    next.policy.globalMinimums[metric] = Number(pct(summary.total, metric).toFixed(2));
  }
  for (const relativeFile of Object.keys(next.criticalFiles || {})) {
    const record = findRecord(relativeFile);
    if (!record) continue;
    for (const metric of metrics) {
      next.criticalFiles[relativeFile][metric] = Number(pct(record, metric).toFixed(2));
    }
  }

  fs.writeFileSync(policyPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `Explicitly rebaselined ${path.relative(root, policyPath)}. Commit the reason and resulting policy change for review.`,
  );
}
