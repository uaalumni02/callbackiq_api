import crypto from 'node:crypto';
import { withDeadline } from '../boundedRedis.service.js';
const busy = () => Object.assign(new Error('Dashboard refresh is busy; retry shortly'), { code: 'CACHE_REFRESH_BUSY', statusCode: 503 });
const PUBLISH = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]); redis.call('DEL', KEYS[1]); return 1`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
// Redis single-primary / Sentinel coordination. Cluster keys must share a hash
// tag if a deployment later adopts Redis Cluster.
export function createCacheRefreshCoordinator({ execute, leaseMs = 15000, waitMs = 1200, pollMs = 40 }) {
  return async ({ key, load, stale, ttlMs, staleMs }) => {
    const lock = `${key}:refresh`, token = crypto.randomUUID(), deadline = Date.now() + waitMs;
    const read = async () => {
      const raw = await execute(client => client.get(key));
      try { const value = JSON.parse(raw); return value && Number(value.staleUntil) > Date.now() ? value : null; } catch { return null; }
    };
    while (true) {
      const shared = await read();
      if (shared?.freshUntil > Date.now()) return shared;
      const owned = await execute(client => client.set(lock, token, { NX: true, PX: leaseMs }));
      if (owned) {
        try {
          // Check once more after taking the lease: another owner may have
          // published between our read and acquisition.
          const current = await read();
          if (current?.freshUntil > Date.now()) return current;
          const value = await withDeadline(load(), leaseMs - 1000, 'CACHE_LOADER_TIMEOUT');
          const now = Date.now(), jitter = 0.9 + Math.random() * 0.1;
          const envelope = { value, freshUntil: now + Math.floor(ttlMs * jitter), staleUntil: now + staleMs };
          const published = await execute(client => client.eval(PUBLISH, { keys: [lock, key], arguments: [token, JSON.stringify(envelope), String(staleMs)] }));
          if (!published) throw busy(); // A late loader cannot overwrite a newer result.
          return envelope;
        } finally {
          await execute(client => client.eval(RELEASE, { keys: [lock], arguments: [token] })).catch(() => {});
        }
      }
      if (shared) return shared;
      if (stale?.staleUntil > Date.now()) return stale;
      if (Date.now() >= deadline) throw busy();
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  };
}
