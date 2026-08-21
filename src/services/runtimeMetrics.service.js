// CALLBACKIQ_PRODUCTION_HARDENING_V1
const MAX_SAMPLES = 5000;
const durationsMs = [];
const statusCounts = new Map();
let activeRequests = 0;
let totalRequests = 0;
let interval = null;

const percentile = (values, p) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((p / 100) * ordered.length) - 1),
  );
  return Math.round(ordered[index] * 100) / 100;
};

const pushDuration = (durationMs) => {
  durationsMs.push(durationMs);
  if (durationsMs.length > MAX_SAMPLES) {
    durationsMs.splice(0, durationsMs.length - MAX_SAMPLES);
  }
};

export const requestMetricsMiddleware = (req, res, next) => {
  activeRequests += 1;
  const startedAt = process.hrtime.bigint();

  res.once("finish", () => {
    activeRequests = Math.max(0, activeRequests - 1);
    totalRequests += 1;
    const elapsedNs = process.hrtime.bigint() - startedAt;
    pushDuration(Number(elapsedNs) / 1_000_000);
    const key = String(res.statusCode || 0);
    statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
  });

  return next();
};

export const snapshotRuntimeMetrics = () => {
  const memory = process.memoryUsage();
  const errorResponses = [...statusCounts.entries()]
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    timestamp: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    },
    http: {
      activeRequests,
      totalRequests,
      errorResponses,
      sampledRequests: durationsMs.length,
      p50Ms: percentile(durationsMs, 50),
      p95Ms: percentile(durationsMs, 95),
      p99Ms: percentile(durationsMs, 99),
      statusCounts: Object.fromEntries(statusCounts),
    },
  };
};

export const startRuntimeMetricsLogging = () => {
  if (
    String(process.env.RUNTIME_METRICS_LOG_ENABLED || "").toLowerCase() !==
    "true"
  ) {
    return;
  }
  if (interval) return;

  const intervalMs = Math.max(
    10000,
    Number.parseInt(process.env.RUNTIME_METRICS_LOG_INTERVAL_MS || "60000", 10) ||
      60000,
  );

  interval = setInterval(() => {
    console.log(
      JSON.stringify({
        event: "callbackiq.runtime_metrics",
        ...snapshotRuntimeMetrics(),
      }),
    );
  }, intervalMs);
  interval.unref?.();
};

export const stopRuntimeMetricsLogging = () => {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
};
