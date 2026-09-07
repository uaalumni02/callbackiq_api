// CALLBACKIQ_PRODUCTION_HARDENING_V1
const firstNonBlank = (...values) =>
  values
    .map((value) => (value == null ? "" : String(value).trim()))
    .find(Boolean) || "";

export const isProductionLike = (env = process.env) =>
  ["production", "staging"].includes(
    String(env.NODE_ENV || "").trim().toLowerCase(),
  );

export const getMongoUrl = (env = process.env) =>
  firstNonBlank(env.MONGODB_URI, env.MONGO_URL, env.MONGO_URI);

export const getCanonicalPublicApiUrl = (env = process.env) =>
  firstNonBlank(
    env.PUBLIC_API_URL,
    env.API_PUBLIC_URL,
    env.TWILIO_WEBHOOK_BASE_URL,
    env.VOICE_HTTP_PUBLIC_URL,
  );

export const normalizeRuntimeEnvironment = (env = process.env) => {
  const mongoUrl = getMongoUrl(env);
  if (mongoUrl) {
    if (!firstNonBlank(env.MONGODB_URI)) env.MONGODB_URI = mongoUrl;
    if (!firstNonBlank(env.MONGO_URL)) env.MONGO_URL = mongoUrl;
  }

  const publicApiUrl = getCanonicalPublicApiUrl(env);
  if (publicApiUrl) {
    if (!firstNonBlank(env.PUBLIC_API_URL)) env.PUBLIC_API_URL = publicApiUrl;
    if (!firstNonBlank(env.API_PUBLIC_URL)) env.API_PUBLIC_URL = publicApiUrl;
    if (!firstNonBlank(env.TWILIO_WEBHOOK_BASE_URL)) {
      env.TWILIO_WEBHOOK_BASE_URL = publicApiUrl;
    }
    if (!firstNonBlank(env.VOICE_HTTP_PUBLIC_URL)) {
      env.VOICE_HTTP_PUBLIC_URL = publicApiUrl;
    }
  }

  return { mongoUrl, publicApiUrl };
};

export const resolveTrustProxy = (value = process.env.TRUST_PROXY, fallback = 1) => {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && String(numeric) === normalized) return numeric;

  // Express accepts IP/subnet strings and comma-separated lists.
  return String(value).trim();
};

const VALID_PROCESS_ROLES = new Set([
  "all",
  "api",
  "voice",
  "worker",
  "worker-sms",
  "worker-automation",
  "worker-a2p",
  "worker-maintenance",
  "worker-voice-usage",
  "worker-lifecycle",
]);

export const getProcessRole = (env = process.env) =>
  firstNonBlank(env.PROCESS_ROLE, "all").toLowerCase();

export const assertValidProcessRole = (env = process.env) => {
  const role = getProcessRole(env);
  if (!VALID_PROCESS_ROLES.has(role)) {
    throw new Error(
      `Invalid PROCESS_ROLE "${role}". Expected one of: ${[
        ...VALID_PROCESS_ROLES,
      ].join(", ")}`,
    );
  }
  return role;
};

export const assertServerProcessRole = (env = process.env) => {
  const role = assertValidProcessRole(env);
  if (!["all", "api", "voice"].includes(role)) {
    throw new Error(
      `PROCESS_ROLE=${role} is a worker-only role. Start build/worker.js instead of build/server.js.`,
    );
  }
  return role;
};

export const shouldRunEmbeddedWorkers = (env = process.env) =>
  getProcessRole(env) === "all";

const readInstanceCount = (env = process.env) => {
  const raw = firstNonBlank(
    env.API_INSTANCE_COUNT,
    env.WEB_CONCURRENCY,
    env.RENDER_INSTANCE_COUNT,
    "1",
  );
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export const assertRealtimeScalingConfig = (env = process.env) => {
  const required =
    String(env.SOCKET_REDIS_REQUIRED || "").toLowerCase() === "true" ||
    (isProductionLike(env) && (readInstanceCount(env) > 1 || getProcessRole(env).startsWith("worker")));

  if (required && !firstNonBlank(env.SOCKET_REDIS_URL, env.REDIS_URL)) {
    throw new Error(
      "Redis is required for multi-instance realtime delivery. Set SOCKET_REDIS_URL or REDIS_URL.",
    );
  }

  if (required) env.SOCKET_REDIS_REQUIRED = "true";
  return { required, instanceCount: readInstanceCount(env) };
};

export const runtimeEnvironment = {
  isProductionLike,
  getMongoUrl,
  getCanonicalPublicApiUrl,
  normalizeRuntimeEnvironment,
  resolveTrustProxy,
  getProcessRole,
  assertValidProcessRole,
  assertServerProcessRole,
  shouldRunEmbeddedWorkers,
  assertRealtimeScalingConfig,
};

export default runtimeEnvironment;
