#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const args = new Set(process.argv.slice(2));
const loadMode = args.has("--load") || args.has("--ai");
const aiMode = args.has("--ai");
const envFlag = (name) => String(process.env[name] || "").trim().toLowerCase() === "true";
const nowStamp = () => new Date().toISOString().replaceAll(":", "-");
const reportPath = process.env.VOICE_CONCURRENCY_REPORT_PATH || `voice-concurrency-certification-${nowStamp()}.json`;

const run = ({ name, command, commandArgs, env = {} }) =>
  new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: { ...process.env, ...env },
      shell: false,
    });
    child.on("error", (error) =>
      resolve({
        name,
        command: [command, ...commandArgs].join(" "),
        passed: false,
        exitCode: null,
        error: error.message,
        durationMs: Number((performance.now() - started).toFixed(2)),
      }),
    );
    child.on("exit", (code, signal) =>
      resolve({
        name,
        command: [command, ...commandArgs].join(" "),
        passed: code === 0,
        exitCode: code,
        signal: signal || null,
        durationMs: Number((performance.now() - started).toFixed(2)),
      }),
    );
  });

const steps = [];

const execute = async (step) => {
  console.log(`\n=== ${step.name} ===`);
  const result = await run(step);
  steps.push(result);
  if (!result.passed) throw new Error(`${step.name} failed.`);
};

let failure = null;
try {
  await execute({
    name: "Deterministic concurrency correctness",
    command: "npm",
    commandArgs: ["run", "test:voice-concurrency"],
  });

  if (loadMode) {
    if (!envFlag("VOICE_LOAD_ALLOW_DB_WRITES")) {
      throw new Error(
        "Load certification requires VOICE_LOAD_ALLOW_DB_WRITES=true and a dedicated load-test database.",
      );
    }

    const expectedMax = String(process.env.VOICE_LOAD_MAX_CONCURRENT || 25);

    await execute({
      name: "Atomic Mongo capacity 50/25",
      command: "npm",
      commandArgs: ["run", "perf:voice:capacity"],
      env: {
        VOICE_CAPACITY_ATTEMPTS: "50",
        VOICE_CAPACITY_EXPECT_MAX: expectedMax,
      },
    });

    await execute({
      name: "Signed voice webhook burst",
      command: "npm",
      commandArgs: ["run", "perf:voice:webhook"],
      env: {
        VOICE_LOAD_REQUESTS: "100",
        VOICE_LOAD_CONCURRENCY: "20",
      },
    });

    for (const clients of [10, 20]) {
      await execute({
        name: `Integrated ConversationRelay ${clients}/${clients}`,
        command: "npm",
        commandArgs: ["run", "perf:voice:relay"],
        env: {
          VOICE_RELAY_CLIENTS: String(clients),
          VOICE_RELAY_EXPECT_ACCEPTED: String(clients),
          VOICE_RELAY_CONNECT_CONCURRENCY: "5",
        },
      });
    }

    await execute({
      name: "Integrated overload 50/25",
      command: "npm",
      commandArgs: ["run", "perf:voice:relay"],
      env: {
        VOICE_RELAY_CLIENTS: "50",
        VOICE_RELAY_EXPECT_ACCEPTED: expectedMax,
        VOICE_RELAY_CONNECT_CONCURRENCY: "5",
      },
    });
  }

  if (aiMode) {
    if (!envFlag("VOICE_LOAD_ALLOW_AI")) {
      throw new Error("AI certification requires VOICE_LOAD_ALLOW_AI=true.");
    }
    await execute({
      name: "Real Voice AI concurrency 10 clients",
      command: "npm",
      commandArgs: ["run", "perf:voice:relay:ai"],
      env: {
        VOICE_RELAY_CLIENTS: "10",
        VOICE_RELAY_EXPECT_ACCEPTED: "10",
        VOICE_RELAY_CONNECT_CONCURRENCY: "5",
        VOICE_RELAY_TURNS: "2",
      },
    });
  }
} catch (error) {
  failure = error;
}

const report = {
  suite: "callbackiq-voice-concurrency-certification",
  generatedAt: new Date().toISOString(),
  mode: aiMode ? "correctness+load+ai" : loadMode ? "correctness+load" : "correctness",
  passed: !failure && steps.every((step) => step.passed),
  zeroToleranceInvariants: [
    "crossTranscriptContamination=0",
    "incorrectLeaseReleases=0",
    "duplicateCallSidSessions=0",
    "orphanedLiveLeases=0",
    "unexpectedSessionTermination=0",
  ],
  steps,
  error: failure?.message || "",
};

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nVoice concurrency report: ${reportPath}`);
console.log(JSON.stringify(report, null, 2));

if (!report.passed) process.exitCode = 1;
