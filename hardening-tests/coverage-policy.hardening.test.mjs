import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ratchetScript = path.join(repoRoot, "scripts", "verify-coverage-ratchet.mjs");
const diffScript = path.join(repoRoot, "scripts", "verify-diff-coverage.mjs");
const riskScript = path.join(repoRoot, "scripts", "report-coverage-risk.mjs");

const metrics = (branches, functions, lines, statements = lines) => ({
  branches: { total: 100, covered: branches, skipped: 0, pct: branches },
  functions: { total: 100, covered: functions, skipped: 0, pct: functions },
  lines: { total: 100, covered: lines, skipped: 0, pct: lines },
  statements: { total: 100, covered: statements, skipped: 0, pct: statements },
});

const makeTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "callbackiq-coverage-policy-"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const runNode = (script, args, { cwd, env = {} } = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

const makeRatchetFixture = () => {
  const root = makeTemp();
  fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "services", "money.js"), "export default true;\n");
  writeJson(path.join(root, "config", "coverage-ratchet.json"), {
    version: 2,
    policy: {
      globalMinimums: { branches: 60, functions: 60, lines: 60, statements: 60 },
      targetMinimums: { branches: 75, functions: 80, lines: 85, statements: 85 },
      diffCoverage: { lines: 85, branches: 75, criticalLines: 90, criticalBranches: 80 },
    },
    criticalFiles: {
      "src/services/money.js": { branches: 70, functions: 70, lines: 80, statements: 80 },
    },
    criticalTargets: {
      moneyTelecomEntitlement: { branches: 75, functions: 85, lines: 90, statements: 90 },
    },
  });
  writeJson(path.join(root, "coverage", "coverage-summary.json"), {
    total: metrics(65, 70, 79),
    [path.join(root, "src", "services", "money.js")]: metrics(68, 80, 75),
  });
  return root;
};

test("ratchet update refuses to paper over a red stale floor", () => {
  const root = makeRatchetFixture();
  const result = runNode(ratchetScript, ["--update"], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Refusing --update/);
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, "config", "coverage-ratchet.json"), "utf8"),
  );
  assert.equal(policy.criticalFiles["src/services/money.js"].lines, 80);
});

test("explicit rebaseline is impossible without both authorization and a reason", () => {
  const root = makeRatchetFixture();
  const result = runNode(ratchetScript, ["--rebaseline"], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /ALLOW_COVERAGE_REBASELINE=1/);
});

test("explicit stale-baseline repair records reason and exact fresh measurements", () => {
  const root = makeRatchetFixture();
  const result = runNode(ratchetScript, ["--rebaseline"], {
    cwd: root,
    env: {
      ALLOW_COVERAGE_REBASELINE: "1",
      COVERAGE_REBASELINE_REASON: "test fixture replaces stale bootstrap coverage",
      GITHUB_ACTOR: "coverage-test",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, "config", "coverage-ratchet.json"), "utf8"),
  );
  assert.equal(policy.policy.globalMinimums.lines, 79);
  assert.equal(policy.criticalFiles["src/services/money.js"].lines, 75);
  assert.equal(policy.criticalFiles["src/services/money.js"].branches, 68);
  assert.equal(policy.lastUpdateMode, "explicit-rebaseline");
  assert.equal(policy.lastRebaseline.actor, "coverage-test");
  assert.match(policy.lastRebaseline.reason, /stale bootstrap coverage/);
});

test("normal update is raise-only after the policy is green", () => {
  const root = makeRatchetFixture();
  // First make the fixture internally green without using the script under test.
  const policyPath = path.join(root, "config", "coverage-ratchet.json");
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  policy.criticalFiles["src/services/money.js"] = {
    branches: 60,
    functions: 70,
    lines: 70,
    statements: 70,
  };
  writeJson(policyPath, policy);

  const result = runNode(ratchetScript, ["--update"], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  assert.equal(next.policy.globalMinimums.lines, 79);
  assert.equal(next.policy.globalMinimums.branches, 65);
  assert.equal(next.criticalFiles["src/services/money.js"].lines, 75);
  assert.equal(next.criticalFiles["src/services/money.js"].functions, 80);
  assert.equal(next.lastUpdateMode, "raise-only");
});



test("risk report prioritizes a high-risk billing surface over equally uncovered general code", () => {
  const root = makeTemp();
  writeJson(path.join(root, "coverage", "coverage-summary.json"), {
    total: metrics(60, 60, 60),
    [path.join(root, "src", "controllers", "billing.js")]: metrics(40, 40, 40),
    [path.join(root, "src", "utils", "format.js")]: metrics(40, 40, 40),
  });
  const result = runNode(riskScript, [], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "coverage", "risk-report.json"), "utf8"),
  );
  assert.equal(report.topRisks[0].file, "src/controllers/billing.js");
  assert.equal(report.topRisks[0].category, "money/entitlement");
});

test("risk report fails when fresh coverage summary is absent", () => {
  const root = makeTemp();
  const result = runNode(riskScript, [], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /coverage-summary\.json is missing/);
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const makeDiffFixture = ({ covered = true, includeInLcov = true } = {}) => {
  const root = makeTemp();
  fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
  writeJson(path.join(root, "config", "coverage-ratchet.json"), {
    policy: {
      diffCoverage: { lines: 85, branches: 75, criticalLines: 90, criticalBranches: 80 },
    },
    criticalFiles: { "src/services/example.js": { lines: 50, statements: 50, functions: 50, branches: 50 } },
  });
  const source = path.join(root, "src", "services", "example.js");
  fs.writeFileSync(
    source,
    'export const choose = (flag) => {\n  return flag ? "yes" : "no";\n};\n',
  );
  git(root, "init", "-q");
  git(root, "config", "user.email", "coverage@example.test");
  git(root, "config", "user.name", "Coverage Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  fs.writeFileSync(
    source,
    'export const choose = (flag) => {\n  return flag ? "YES" : "NO";\n};\n',
  );
  git(root, "add", "src/services/example.js");
  git(root, "commit", "-qm", "change");

  const lcov = includeInLcov
    ? [
        "TN:",
        `SF:${source}`,
        "FN:1,choose",
        "FNDA:1,choose",
        "DA:1,1",
        `DA:2,${covered ? 1 : 0}`,
        "DA:3,1",
        `BRDA:2,0,0,${covered ? 1 : 0}`,
        `BRDA:2,0,1,${covered ? 1 : 0}`,
        "end_of_record",
        "",
      ].join("\n")
    : "TN:\n";
  fs.writeFileSync(path.join(root, "coverage", "lcov.info"), lcov);
  return root;
};

test("diff coverage passes a fully covered critical changed branch", () => {
  const root = makeDiffFixture({ covered: true });
  const result = runNode(diffScript, [], {
    cwd: root,
    env: { DIFF_COVERAGE_BASE: "HEAD^" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Changed-code coverage gate passed/);
});

test("diff coverage rejects an uncovered critical changed line/branch", () => {
  const root = makeDiffFixture({ covered: false });
  const result = runNode(diffScript, [], {
    cwd: root,
    env: { DIFF_COVERAGE_BASE: "HEAD^" },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /changed lines: 0\.00% < 90\.00%/);
});

test("diff coverage fails if changed source is absent from LCOV", () => {
  const root = makeDiffFixture({ includeInLcov: false });
  const result = runNode(diffScript, [], {
    cwd: root,
    env: { DIFF_COVERAGE_BASE: "HEAD^" },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /absent from lcov\.info/);
});
