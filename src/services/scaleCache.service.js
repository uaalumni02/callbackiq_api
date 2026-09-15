import { createCacheRefreshCoordinator } from "./scale/cacheRefresh.service.js";
import { safeConsole } from "../helpers/logging/safeLogger.js";
// CALLBACKIQ_SCALE_HARDENING_V1
import { createBoundedRedis } from "./boundedRedis.service.js";

const memory = new Map();
const inflight = new Map();
let activeLoaders = 0;
const refreshNotBefore = new Map();

const bool = (value, fallback = false) => {
  if (value == null || String(value).trim() === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
};

const integer = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const cacheEnabled = () =>
  bool(process.env.SCALE_CACHE_ENABLED, process.env.NODE_ENV !== "test");

const cacheNamespace = () =>
  String(process.env.SCALE_CACHE_NAMESPACE || "callbackiq:scale:v1").trim();

const cacheRedisUrl = () =>
  String(
    process.env.SCALE_CACHE_REDIS_URL ||
      process.env.REDIS_URL ||
      process.env.SOCKET_REDIS_URL ||
      "",
  ).trim();

const memoryMaxEntries = () =>
  integer(process.env.SCALE_CACHE_MEMORY_MAX_ENTRIES, 5000, {
    min: 50,
    max: 100000,
  });

const serialize = (value) => JSON.stringify(value);

const parseEnvelope = (raw) => {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return null;
    if (!Number.isFinite(Number(value.freshUntil))) return null;
    if (!Number.isFinite(Number(value.staleUntil))) return null;
    return value;
  } catch {
    return null;
  }
};

const pruneMemory = () => {
  const maxEntries = memoryMaxEntries();
  while (memory.size > maxEntries) {
    const oldestKey = memory.keys().next().value;
    if (!oldestKey) break;
    memory.delete(oldestKey);
  }
};

const setMemory = (key, envelope) => {
  memory.delete(key);
  memory.set(key, envelope);
  pruneMemory();
};

const getMemory = (key) => {
  const envelope = memory.get(key);
  if (!envelope) return null;
  if (Number(envelope.staleUntil) <= Date.now()) {
    memory.delete(key);
    return null;
  }

  // Refresh insertion order so frequently used tenant keys stay hot.
  memory.delete(key);
  memory.set(key, envelope);
  return envelope;
};

const redis = createBoundedRedis({ url: cacheRedisUrl, name: "cache" });
const connectRedis = async () => cacheRedisUrl() ? {
  get: key => redis.execute(client => client.get(key)),
  set: (key, value, options) => redis.execute(client => client.set(key, value, options)),
  del: key => redis.execute(client => client.del(key)),
} : null;

const fullKey = (key) => `${cacheNamespace()}:${String(key)}`;

const readRedis = async (key) => {
  const client = await connectRedis();
  if (!client) return null;
  try {
    const raw = await client.get(fullKey(key));
    return parseEnvelope(raw);
  } catch (error) {
    safeConsole.error("Scale cache Redis read failed:", error?.message || error);
    return null;
  }
};

const coordinate = createCacheRefreshCoordinator({ execute: async operation => {
  try { return await redis.execute(operation); }
  catch (cause) { throw Object.assign(new Error("Redis cache unavailable"), { code: "REDIS_CACHE_UNAVAILABLE", cause }); }
} });
const loadFresh = async ({ key, loader, ttlMs, staleMs }) => {
  if (inflight.has(key)) return inflight.get(key);
  const maximum = integer(process.env.SCALE_CACHE_MAX_LOADERS, 8, { min: 1, max: 100 });
  if (inflight.size >= maximum * 4) throw Object.assign(new Error("Cache refresh capacity reached"), { code: "CACHE_REFRESH_BUSY", statusCode: 503 });
  const guardedLoader = async () => {
    if (activeLoaders >= maximum) throw Object.assign(new Error("Cache refresh capacity reached"), { code: "CACHE_REFRESH_BUSY", statusCode: 503 });
    activeLoaders++;
    try { return await loader(); } finally { activeLoaders--; }
  };
  const promise = (async () => {
    let envelope;
    if (cacheRedisUrl()) {
      try {
        envelope = await coordinate({ key: fullKey(key), load: guardedLoader, stale: getMemory(key), ttlMs, staleMs });
      } catch (error) {
        // Coordination contention never starts another database refresh. Only
        // a Redis outage permits the bounded per-process fallback.
        if (!String(error.code || "").startsWith("REDIS_")) throw error;
      }
    }
    if (!envelope) {
      const value = await guardedLoader(), now = Date.now();
      envelope = { value, freshUntil: now + ttlMs, staleUntil: now + staleMs };
    }
    setMemory(key, envelope);
    return envelope.value;
  })();
  inflight.set(key, promise);
  try { return await promise; }
  finally { if (inflight.get(key) === promise) inflight.delete(key); }
};

const refreshInBackground = (options) => {
  if ((refreshNotBefore.get(options.key) || 0) > Date.now()) return;
  refreshNotBefore.set(options.key, Date.now() + 1000);
  while (refreshNotBefore.size > memoryMaxEntries()) refreshNotBefore.delete(refreshNotBefore.keys().next().value);
  void loadFresh(options).catch((error) => {
    refreshNotBefore.set(options.key, Date.now() + 2000);
    safeConsole.error("Scale cache background refresh failed:", error?.code || "CACHE_REFRESH_FAILED");
  });
};

export const getOrLoadScaleCache = async ({
  key,
  loader,
  ttlMs = 5000,
  staleMs = 20000,
}) => {
  if (typeof loader !== "function") {
    throw new TypeError("Scale cache loader must be a function.");
  }

  if (!cacheEnabled()) return loader();

  const safeTtlMs = integer(ttlMs, 5000, { min: 100, max: 300000 });
  const safeStaleMs = Math.max(
    safeTtlMs,
    integer(staleMs, 20000, { min: safeTtlMs, max: 900000 }),
  );
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return loader();

  const now = Date.now();

  const local = getMemory(normalizedKey);
  if (local) {
    if (Number(local.freshUntil) > now) return local.value;
    refreshInBackground({
      key: normalizedKey,
      loader,
      ttlMs: safeTtlMs,
      staleMs: safeStaleMs,
    });
    return local.value;
  }

  const distributed = await readRedis(normalizedKey);
  if (distributed && Number(distributed.staleUntil) > now) {
    setMemory(normalizedKey, distributed);
    if (Number(distributed.freshUntil) <= now) {
      refreshInBackground({
        key: normalizedKey,
        loader,
        ttlMs: safeTtlMs,
        staleMs: safeStaleMs,
      });
    }
    return distributed.value;
  }

  return loadFresh({
    key: normalizedKey,
    loader,
    ttlMs: safeTtlMs,
    staleMs: safeStaleMs,
  });
};

export const deleteScaleCacheKey = async (key) => {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return;
  memory.delete(normalizedKey);
  const client = await connectRedis();
  if (!client) return;
  try {
    await client.del(fullKey(normalizedKey));
  } catch (error) {
    safeConsole.error("Scale cache Redis delete failed:", error?.message || error);
  }
};

export const clearLocalScaleCache = () => {
  memory.clear();
  inflight.clear();
  refreshNotBefore.clear();
};

export const closeScaleCache = async () => {
  clearLocalScaleCache();
  redis.close();
};

export default {
  getOrLoad: getOrLoadScaleCache,
  delete: deleteScaleCacheKey,
  clearLocal: clearLocalScaleCache,
  close: closeScaleCache,
};
