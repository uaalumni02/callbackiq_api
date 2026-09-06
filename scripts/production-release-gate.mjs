// CALLBACKIQ_PRODUCTION_HARDENING_V1
import "dotenv/config";
import { validateEnvironment } from "../src/config/env.js";
import {
  assertRealtimeScalingConfig,
  getCanonicalPublicApiUrl,
  getMongoUrl,
  getProcessRole,
  isProductionLike,
  normalizeRuntimeEnvironment,
} from "../src/config/runtime-environment.js";

const failures = [];
const warnings = [];

normalizeRuntimeEnvironment();

try {
  const releaseEnvironment = {
    ...process.env,
    MONGODB_URI:
      process.env.MONGODB_URI ||
      process.env.MONGO_URL ||
      process.env.MONGO_URI,
  };

  validateEnvironment(releaseEnvironment, { throwOnError: true });
} catch (error) {
  failures.push(error?.message || String(error));
}

try {
  assertRealtimeScalingConfig();
} catch (error) {
  failures.push(error?.message || String(error));
}

if (!getMongoUrl()) failures.push("Canonical MongoDB URI is missing");
if (!getCanonicalPublicApiUrl()) failures.push("Canonical public API URL is missing");

if (isProductionLike()) {
  if (
    ["http://localhost", "http://127.0.0.1"].some((prefix) =>
      String(process.env.CLIENT_URL || "").startsWith(prefix),
    )
  ) {
    failures.push("CLIENT_URL must not be localhost in production/staging");
  }

  if (
    String(process.env.AUTH_RESPONSE_TOKEN_ENABLED || "").toLowerCase() ===
    "true"
  ) {
    failures.push(
      "AUTH_RESPONSE_TOKEN_ENABLED=true is forbidden in production/staging",
    );
  }

  if (getProcessRole() === "all") {
    warnings.push(
      "PROCESS_ROLE=all couples HTTP and background workers. Use PROCESS_ROLE=api for web replicas plus a separate build/worker.js deployment.",
    );
  }
}

const result = {
  ok: failures.length === 0,
  environment: process.env.NODE_ENV || "development",
  processRole: getProcessRole(),
  failures,
  warnings,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
