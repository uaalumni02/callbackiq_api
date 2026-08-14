#!/usr/bin/env node
import { performance } from "node:perf_hooks";

const target =
  process.env.PERF_TARGET_URL || "http://127.0.0.1:3000/api/twilio/sms";
const total = Math.max(1, Number(process.env.PERF_REQUESTS || 50));
const concurrency = Math.max(
  1,
  Math.min(total, Number(process.env.PERF_CONCURRENCY || 50)),
);
const timeoutMs = Math.max(250, Number(process.env.PERF_TIMEOUT_MS || 10000));

const url = new URL(target);
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (
  !localHosts.has(url.hostname) &&
  String(process.env.ALLOW_REMOTE_LOAD_TEST || "").toLowerCase() !== "true"
) {
  throw new Error(
    `Refusing remote load test against ${url.hostname}. ` +
      "Set ALLOW_REMOTE_LOAD_TEST=true only when you own/are authorized to test the target.",
  );
}

const body =
  process.env.PERF_FORM_BODY ||
  new URLSearchParams({
    From: "+14045550100",
    To: "+16785550123",
    Body: "Performance harness test message",
    MessageSid: "SM_PERF_PLACEHOLDER",
    SmsSid: "SM_PERF_PLACEHOLDER",
    NumMedia: "0",
  }).toString();

const extraHeaders = process.env.PERF_HEADERS_JSON
  ? JSON.parse(process.env.PERF_HEADERS_JSON)
  : {};

const results = [];
let next = 0;

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

const one = async (index) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(target, {
      method: process.env.PERF_METHOD || "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      },
      body: body.replace(
        /SM_PERF_PLACEHOLDER/g,
        `SM${String(index).padStart(32, "0").slice(-32)}`,
      ),
      signal: controller.signal,
    });
    await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: performance.now() - started,
      error: error?.name || error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

const worker = async () => {
  while (true) {
    const index = next++;
    if (index >= total) return;
    results.push(await one(index));
  }
};

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedMs = performance.now() - started;

const durations = results.map((item) => item.durationMs);
const success = results.filter((item) => item.ok).length;
const statuses = Object.fromEntries(
  [...new Set(results.map((item) => item.status))].map((status) => [
    status,
    results.filter((item) => item.status === status).length,
  ]),
);

console.log(
  JSON.stringify(
    {
      target,
      requests: total,
      concurrency,
      success,
      failures: total - success,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      requestsPerSecond: Number((total / (elapsedMs / 1000)).toFixed(2)),
      latencyMs: {
        p50: Number(percentile(durations, 0.5).toFixed(2)),
        p95: Number(percentile(durations, 0.95).toFixed(2)),
        p99: Number(percentile(durations, 0.99).toFixed(2)),
        max: Number(Math.max(...durations).toFixed(2)),
      },
      statuses,
    },
    null,
    2,
  ),
);

if (success !== total) process.exitCode = 1;
