// CALLBACKIQ_PRODUCTION_HARDENING_V1
const target =
  process.env.PERF_BUDGET_URL || "http://127.0.0.1:3000/api/health/live";
const requestCount = Math.max(
  1,
  Number.parseInt(process.env.PERF_BUDGET_REQUESTS || "50", 10) || 50,
);
const concurrency = Math.max(
  1,
  Number.parseInt(process.env.PERF_BUDGET_CONCURRENCY || "10", 10) || 10,
);
const p95Budget = Number(process.env.PERF_BUDGET_P95_MS || 500);
const p99Budget = Number(process.env.PERF_BUDGET_P99_MS || 1000);

const parsed = new URL(target);
const isLocal = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
if (
  !isLocal &&
  String(process.env.PERF_ALLOW_REMOTE || "").toLowerCase() !== "true"
) {
  throw new Error(
    "Refusing to load-test a remote URL. Set PERF_ALLOW_REMOTE=true only for an authorized target.",
  );
}

const durations = [];
const statuses = new Map();
let nextIndex = 0;

const worker = async () => {
  while (nextIndex < requestCount) {
    nextIndex += 1;
    const started = performance.now();
    try {
      const response = await fetch(target, {
        method: process.env.PERF_BUDGET_METHOD || "GET",
        signal: AbortSignal.timeout(
          Number.parseInt(process.env.PERF_BUDGET_TIMEOUT_MS || "5000", 10),
        ),
      });
      statuses.set(
        response.status,
        (statuses.get(response.status) || 0) + 1,
      );
      await response.arrayBuffer();
    } catch {
      statuses.set("error", (statuses.get("error") || 0) + 1);
    } finally {
      durations.push(performance.now() - started);
    }
  }
};

await Promise.all(
  Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()),
);

const ordered = durations.sort((a, b) => a - b);
const percentile = (p) =>
  ordered[Math.min(ordered.length - 1, Math.ceil((p / 100) * ordered.length) - 1)] ||
  0;

const result = {
  target,
  requests: requestCount,
  concurrency,
  p50Ms: Math.round(percentile(50) * 100) / 100,
  p95Ms: Math.round(percentile(95) * 100) / 100,
  p99Ms: Math.round(percentile(99) * 100) / 100,
  maxMs: Math.round((ordered.at(-1) || 0) * 100) / 100,
  p95BudgetMs: p95Budget,
  p99BudgetMs: p99Budget,
  statuses: Object.fromEntries(statuses),
};

console.log(JSON.stringify(result, null, 2));

const hasError =
  statuses.has("error") ||
  [...statuses.keys()].some(
    (status) => typeof status === "number" && status >= 500,
  );

if (hasError || result.p95Ms > p95Budget || result.p99Ms > p99Budget) {
  process.exitCode = 1;
}
