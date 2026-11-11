#!/usr/bin/env node
/**
 * READ-ONLY MeekCall deployment smoke test. Never places calls, sends SMS,
 * signs in, exposes credentials, or modifies production services.
 */
import { argv } from "node:process";
const arg = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const base = String(arg("--base-url") || process.env.PUBLIC_API_URL || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+/i.test(base)) {
  console.error("Specify a public HTTPS endpoint with --base-url https://callbackiq-api.onrender.com");
  process.exitCode = 2;
} else {
  const paths = ["/api/health/live", "/api/health/ready"];
  for (const path of paths) {
    try {
      const url = new URL(path, base);
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: "application/json" }, redirect: "error" });
      const type = response.headers.get("content-type") || "";
      if (!type.includes("application/json")) throw new Error(`Expected JSON, got ${type || "unknown"}; check frontend /api routing`);
      const data = await response.json();
      if (path.endsWith("/live")) {
        console.log(`Live: HTTP ${response.status}; service=${data.service || "unknown"}; commit=${data.commit || "unreported"}; environment=${data.environment || "unknown"}`);
      } else {
        const checks = data.checks || {};
        console.log(`Ready: HTTP ${response.status}; database=${checks.database || "unknown"}; realtime=${checks.realtime || "unknown"}; automation=${checks.automation || "unknown"}; remoteWorkers=${checks.remoteWorkers || "unknown"}`);
        if (checks.remoteWorkers === "not_checked") console.warn("IMPORTANT: API readiness did NOT verify remote background workers. Check the admin /api/admin/scale-health view.");
      }
      if (!response.ok || data.success !== true) process.exitCode = 1;
    } catch (err) {
      console.error(`${path}: ${err?.message || "request failed"}`);
      process.exitCode = 1;
    }
  }
  console.log("This probe does NOT prove SMS delivery, voice quality, worker throughput or appointment confirmations.");
}
