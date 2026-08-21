import { EventEmitter } from "events";
import {
  requestMetricsMiddleware,
  snapshotRuntimeMetrics,
  startRuntimeMetricsLogging,
  stopRuntimeMetricsLogging,
} from "../../src/services/runtimeMetrics.service.js";

describe("runtime metrics", () => {
  const originalEnv = process.env;

  afterEach(() => {
    stopRuntimeMetricsLogging();
    process.env = { ...originalEnv };
  });

  test("records request duration and status", () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const next = jest.fn();

    requestMetricsMiddleware({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.emit("finish");
    const snapshot = snapshotRuntimeMetrics();
    expect(snapshot.http.totalRequests).toBeGreaterThanOrEqual(1);
    expect(snapshot.http.statusCounts["200"]).toBeGreaterThanOrEqual(1);
    expect(snapshot.http.p95Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.process.rssBytes).toBeGreaterThan(0);
  });

  test("can start and stop structured logging", () => {
    process.env.RUNTIME_METRICS_LOG_ENABLED = "true";
    process.env.RUNTIME_METRICS_LOG_INTERVAL_MS = "10000";
    expect(() => startRuntimeMetricsLogging()).not.toThrow();
    expect(() => startRuntimeMetricsLogging()).not.toThrow();
    expect(() => stopRuntimeMetricsLogging()).not.toThrow();
  });

  test("logging is disabled by default", () => {
    delete process.env.RUNTIME_METRICS_LOG_ENABLED;
    expect(() => startRuntimeMetricsLogging()).not.toThrow();
  });
});
