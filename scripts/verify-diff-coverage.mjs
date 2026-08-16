#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const realpathIfPossible = (value) => {
  try {
    return fs.realpathSync.native
      ? fs.realpathSync.native(value)
      : fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

const root = realpathIfPossible(process.cwd());
const lcovPath = path.join(root, "coverage", "lcov.info");
const policyPath = path.join(root, "config", "coverage-ratchet.json");
const EPSILON = 1e-9;

const fail = (message) => {
  console.error(`DIFF COVERAGE FAIL: ${message}`);
  process.exitCode = 1;
};

if (!fs.existsSync(lcovPath)) {
  fail("coverage/lcov.info is missing. Run npm run test:coverage first.");
  process.exit();
}
if (!fs.existsSync(policyPath)) {
  fail("config/coverage-ratchet.json is missing.");
  process.exit();
}

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const thresholds = {
  lines: Number(policy.policy?.diffCoverage?.lines ?? 85),
  branches: Number(policy.policy?.diffCoverage?.branches ?? 75),
  criticalLines: Number(policy.policy?.diffCoverage?.criticalLines ?? 90),
  criticalBranches: Number(policy.policy?.diffCoverage?.criticalBranches ?? 80),
};

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commitExists = (ref) => {
  if (!ref || /^0+$/.test(ref)) return false;
  try {
    git("rev-parse", "--verify", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

const resolveBase = () => {
  const explicit = String(process.env.DIFF_COVERAGE_BASE || "").trim();
  if (commitExists(explicit)) return explicit;

  const githubBaseRef = String(process.env.GITHUB_BASE_REF || "").trim();
  if (githubBaseRef && commitExists(`origin/${githubBaseRef}`)) {
    try {
      return git("merge-base", "HEAD", `origin/${githubBaseRef}`);
    } catch {
      return `origin/${githubBaseRef}`;
    }
  }

  for (const candidate of ["HEAD^", "origin/main", "origin/development"]) {
    if (commitExists(candidate)) return candidate;
  }
  return "";
};

const base = resolveBase();
if (!base) {
  console.log("Diff coverage skipped: no usable Git base commit is available.");
  process.exit(0);
}

let diff = "";
try {
  diff = git("diff", "--unified=0", "--no-color", `${base}...HEAD`, "--", "src");
} catch (error) {
  fail(`Unable to compute Git diff from ${base}: ${error.stderr || error.message}`);
  process.exit();
}

if (!diff) {
  console.log(`Diff coverage passed: no src changes relative to ${base}.`);
  process.exit(0);
}

const normalize = (value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
const changed = new Map();
let currentFile = "";
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ b/")) {
    currentFile = normalize(line.slice(6));
    if (!changed.has(currentFile)) changed.set(currentFile, new Set());
    continue;
  }
  if (!currentFile || !line.startsWith("@@")) continue;
  const match = line.match(/\+(\d+)(?:,(\d+))?/);
  if (!match) continue;
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  for (let offset = 0; offset < count; offset += 1) {
    changed.get(currentFile).add(start + offset);
  }
}

const lcov = new Map();
let current = null;
for (const line of fs.readFileSync(lcovPath, "utf8").split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    const rawPath = line.slice(3);
    const relative = path.isAbsolute(rawPath)
      ? path.relative(root, realpathIfPossible(rawPath))
      : rawPath;
    current = { lines: new Map(), branches: [] };
    lcov.set(normalize(relative), current);
    continue;
  }
  if (!current) continue;
  if (line.startsWith("DA:")) {
    const [lineNo, hits] = line.slice(3).split(",");
    current.lines.set(Number(lineNo), Number(hits));
  } else if (line.startsWith("BRDA:")) {
    const [lineNo, block, branch, taken] = line.slice(5).split(",");
    current.branches.push({
      line: Number(lineNo),
      block,
      branch,
      hits: taken === "-" ? 0 : Number(taken),
    });
  } else if (line === "end_of_record") {
    current = null;
  }
}

const criticalFiles = new Set(Object.keys(policy.criticalFiles || {}).map(normalize));
const failures = [];
const results = [];

for (const [file, changedLines] of changed.entries()) {
  const record = lcov.get(file);
  if (!record) {
    failures.push(`${file}: changed source file is absent from lcov.info`);
    continue;
  }

  const executable = [...changedLines].filter((lineNo) => record.lines.has(lineNo));
  const coveredLines = executable.filter((lineNo) => Number(record.lines.get(lineNo)) > 0);
  const changedBranches = record.branches.filter((branch) => changedLines.has(branch.line));
  const coveredBranches = changedBranches.filter((branch) => branch.hits > 0);
  const linePct = executable.length ? (coveredLines.length / executable.length) * 100 : 100;
  const branchPct = changedBranches.length
    ? (coveredBranches.length / changedBranches.length) * 100
    : 100;
  const critical = criticalFiles.has(file);
  const minLines = critical ? thresholds.criticalLines : thresholds.lines;
  const minBranches = critical ? thresholds.criticalBranches : thresholds.branches;

  results.push({
    file,
    critical,
    linePct,
    branchPct,
    executable: executable.length,
    branches: changedBranches.length,
  });

  if (executable.length && linePct + EPSILON < minLines) {
    failures.push(
      `${file} changed lines: ${linePct.toFixed(2)}% < ${minLines.toFixed(2)}% (${coveredLines.length}/${executable.length})`,
    );
  }
  if (changedBranches.length && branchPct + EPSILON < minBranches) {
    failures.push(
      `${file} changed branches: ${branchPct.toFixed(2)}% < ${minBranches.toFixed(2)}% (${coveredBranches.length}/${changedBranches.length})`,
    );
  }
}

console.log(`\nDiff coverage relative to ${base}:`);
for (const result of results.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(
    `  - ${result.file}${result.critical ? " [critical]" : ""}: ` +
      `lines ${result.linePct.toFixed(2)}% (${result.executable}), ` +
      `branches ${result.branchPct.toFixed(2)}% (${result.branches})`,
  );
}

if (failures.length) {
  console.error("\nChanged-code coverage gate failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Changed-code coverage gate passed.");
