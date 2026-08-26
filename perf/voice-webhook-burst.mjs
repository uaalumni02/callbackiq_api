#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { getExpectedTwilioSignature } = require("twilio/lib/webhooks/webhooks");

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const flag = (name) => env(name).toLowerCase() === "true";
const positiveInt = (name, fallback, max = 100000) => {
  const parsed = Number.parseInt(env(name, fallback), 10);
  return Math.min(max, Math.max(1, Number.isFinite(parsed) ? parsed : Number(fallback)));
};
const trimSlash = (value) => String(value || "").replace(/\/+$/, "");

const targetBase = trimSlash(env("VOICE_LOAD_HTTP_TARGET", "http://127.0.0.1:3000"));
const signatureBase = trimSlash(
  env("VOICE_LOAD_SIGNATURE_HTTP_BASE", env("TWILIO_WEBHOOK_BASE_URL", targetBase)),
);
const targetUrl = `${targetBase}/api/twilio/voice`;
const signatureUrl = `${signatureBase}/api/twilio/voice`;
const authToken = env("TWILIO_AUTH_TOKEN");
const accountSid = env("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
const to = env("VOICE_LOAD_TO", "+12025550123");
const fromBase = env("VOICE_LOAD_FROM_BASE", "+14045550000");
const total = positiveInt("VOICE_LOAD_REQUESTS", 100, 100000);
const concurrency = Math.min(total, positiveInt("VOICE_LOAD_CONCURRENCY", 10, 500));
const timeoutMs = positiveInt("VOICE_LOAD_TIMEOUT_MS", 10000, 120000);
const expectedRoute = env("VOICE_LOAD_EXPECT_ROUTE", "relay").toLowerCase();
const runId = env("VOICE_LOAD_RUN_ID", new Date().toISOString());
const outputPath = env(
  "VOICE_LOAD_REPORT_PATH",
  `voice-webhook-load-${new Date().toISOString().replaceAll(":", "-")}.json`,
);

if (!authToken) throw new Error("TWILIO_AUTH_TOKEN is required to generate valid webhook signatures.");
if (!flag("VOICE_LOAD_ALLOW_DB_WRITES")) {
  throw new Error(
    "Refusing to generate synthetic call records. Set VOICE_LOAD_ALLOW_DB_WRITES=true only against the dedicated load-test database.",
  );
}

const target = new URL(targetBase);
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (!localHosts.has(target.hostname) && !flag("ALLOW_REMOTE_LOAD_TEST")) {
  throw new Error(
    `Refusing remote load test against ${target.hostname}. Set ALLOW_REMOTE_LOAD_TEST=true only for a staging target you own.`,
  );
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

const routeFromTwiml = (text) => {
  if (/<ConversationRelay\b/i.test(text)) return "relay";
  if (/<Dial\b/i.test(text)) return "dial";
  if (/<Say\b/i.test(text)) return "say";
  if (/<Response\s*><\/Response>/i.test(text)) return "empty";
  return "unknown";
};

const sidFor = (index) =>
  `CA${createHash("sha256").update(`${runId}:${index}`).digest("hex").slice(0, 32)}`;

const callerFor = (index) => {
  const digits = fromBase.replace(/\D/g, "");
  const width = Math.max(4, Math.min(8, String(total + 100).length + 1));
  const head = digits.slice(0, Math.max(1, digits.length - width));
  const tail = Number.parseInt(digits.slice(-width), 10) || 0;
  const modulus = 10 ** width;
  const next = String((tail + index) % modulus).padStart(width, "0");
  return `+${head}${next}`;
};

const postVoice = async (index) => {
  const params = {
    AccountSid: accountSid,
    CallSid: sidFor(index),
    From: callerFor(index),
    To: to,
    Caller: callerFor(index),
    Called: to,
    Direction: "inbound",
    CallStatus: "ringing",
    ApiVersion: "2010-04-01",
  };
  const signature = getExpectedTwilioSignature(authToken, signatureUrl, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: new URLSearchParams(params),
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      route: routeFromTwiml(body),
      durationMs: performance.now() - started,
      callSid: params.CallSid,
      bodyPreview: body.slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      route: "error",
      durationMs: performance.now() - started,
      callSid: params.CallSid,
      error: error?.name || error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

console.log("Running one signed voice-webhook preflight...");
const preflight = await postVoice(-1);
console.log(JSON.stringify(preflight, null, 2));
if (!preflight.ok || preflight.route !== expectedRoute) {
  throw new Error(
    `Preflight did not return expected route \"${expectedRoute}\". Aborting before bulk load. ` +
      `Observed HTTP ${preflight.status}, route=${preflight.route}.`,
  );
}

const results = [];
let next = 0;
const worker = async () => {
  while (true) {
    const index = next++;
    if (index >= total) return;
    results.push(await postVoice(index));
  }
};

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedMs = performance.now() - started;
const durations = results.map((item) => item.durationMs);
const success = results.filter((item) => item.ok && item.route === expectedRoute).length;
const statusCounts = {};
const routeCounts = {};
for (const result of results) {
  statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
  routeCounts[result.route] = (routeCounts[result.route] || 0) + 1;
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: "signed-voice-webhook-burst",
  targetUrl,
  signatureUrl,
  businessNumber: to,
  expectedRoute,
  requests: total,
  concurrency,
  success,
  failures: total - success,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  requestsPerSecond: Number((total / Math.max(0.001, elapsedMs / 1000)).toFixed(2)),
  latencyMs: {
    p50: Number(percentile(durations, 0.5).toFixed(2)),
    p95: Number(percentile(durations, 0.95).toFixed(2)),
    p99: Number(percentile(durations, 0.99).toFixed(2)),
    max: Number(Math.max(...durations, 0).toFixed(2)),
  },
  statusCounts,
  routeCounts,
  preflight,
  sampleFailures: results.filter((item) => !item.ok || item.route !== expectedRoute).slice(0, 10),
};

await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${outputPath}`);
if (success !== total) process.exitCode = 1;
