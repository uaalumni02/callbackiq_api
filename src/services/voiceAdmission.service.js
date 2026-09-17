import crypto from "crypto";
import { createBoundedRedis } from "./boundedRedis.service.js";

const positive = (value, fallback) => Math.max(1, Math.min(10000, Number(value) || fallback));
const fleet = createBoundedRedis({ url: () => process.env.VOICE_CAPACITY_REDIS_URL || process.env.REDIS_URL || process.env.SOCKET_REDIS_URL, name: "voice-capacity" });
const RESERVE = `
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ms + tonumber(ARGV[3]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1`;
export const acquireFleetVoiceSlot = async (kind = "sessions") => {
  const maximum = Number(process.env[kind === "sessions" ? "VOICE_FLEET_MAX_SESSIONS" : "VOICE_FLEET_MAX_AI_TURNS"]);
  if (!(maximum > 0)) return async () => {};
  const token = crypto.randomUUID();
  const key = `${process.env.SCALE_CACHE_NAMESPACE || "callbackiq:scale:v1"}:voice:${kind}`;
  const ttl = kind === "sessions" ? 720000 : 180000;
  const allowed = await fleet.execute(client => client.eval(RESERVE, { keys: [key], arguments: [String(maximum), token, String(ttl)] }));
  if (!allowed) throw Object.assign(new Error("Voice fleet capacity reached"), { code: "VOICE_ADMISSION_FULL" });
  return () => fleet.execute(client => client.zRem(key, token)).catch(() => {});
};

export const createVoiceAdmission = (options = {}) => {
  const limits = {
    pending: positive(options.pending ?? process.env.VOICE_INSTANCE_MAX_PENDING, 100),
    sessions: positive(options.sessions ?? process.env.VOICE_INSTANCE_MAX_SESSIONS, 100),
    turns: positive(options.turns ?? process.env.VOICE_INSTANCE_MAX_AI_TURNS, 50),
  };
  const waitMs = Math.max(0, Math.min(5000, Number(options.waitMs ?? process.env.VOICE_TURN_QUEUE_WAIT_MS) || 0));
  const maxWaiting = positive(options.maxWaiting ?? process.env.VOICE_TURN_QUEUE_MAX, 100);
  const queue = [];
  const listeners = new Set();
  let pending = 0, sessions = 0, turns = 0, draining = false, rejected = 0;
  const timing = { completed: 0, failed: 0, queueWaitMs: 0, maxQueueWaitMs: 0, processingMs: 0 };
  const full = () => Object.assign(new Error("Voice turn capacity reached"), { code: "VOICE_ADMISSION_FULL" });
  const canceled = signal => signal?.reason || Object.assign(new Error("Turn canceled"), { code: "VOICE_STALE_TURN" });
  const wake = () => { for (const listener of [...listeners]) listener(); };
  const pause = (signal, ms) => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); listeners.delete(done); signal?.removeEventListener("abort", abort); };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(canceled(signal)); };
    const timer = setTimeout(done, Math.max(1, ms));
    listeners.add(done);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  const admission = {
    // Existing sessions may finish their turns while connection admission drains.
    drain: () => { draining = true; },
    snapshot: () => ({ pending, sessions, turns, waiting: queue.length, draining, rejected, limits: { ...limits }, timing: { ...timing } }),
    acquireConnection: () => {
      if (draining || pending >= limits.pending || sessions + pending >= limits.sessions) { rejected++; return null; }
      pending++;
      let state = "pending";
      return {
        activate: () => { if (state === "pending") { pending--; sessions++; state = "active"; } },
        release: () => { if (state === "pending") pending--; if (state === "active") sessions--; state = "released"; },
      };
    },
    runTurn: async (operation, { signal, onTiming } = {}) => {
      const started = performance.now(), deadline = started + waitMs;
      const ticket = {};
      let reserved = false, release, processingStarted, outcome = "failed";
      try {
        if (signal?.aborted) throw canceled(signal);
        if (queue.length >= maxWaiting || ((turns >= limits.turns || queue.length) && waitMs === 0)) { rejected++; throw full(); }
        queue.push(ticket);
        let waited = false;
        while (!reserved) {
          if (signal?.aborted) throw canceled(signal);
          if (waited && performance.now() >= deadline) { rejected++; throw full(); }
          if (queue[0] === ticket && turns < limits.turns) {
            queue.shift(); turns++; reserved = true; wake();
          } else {
            waited = true;
            await pause(signal, deadline - performance.now());
          }
        }
        // Keep the local reservation during fleet contention. New arrivals cannot
        // steal a released local slot from an older queued caller.
        while (!release) {
          if (signal?.aborted) throw canceled(signal);
          try { release = await (options.acquireFleetSlot || acquireFleetVoiceSlot)("turns"); }
          catch (error) {
            if (error.code !== "VOICE_ADMISSION_FULL") throw error;
            if (performance.now() >= deadline) { rejected++; throw full(); }
            await pause(signal, Math.min(25, deadline - performance.now()));
          }
          if (!release && performance.now() >= deadline) { rejected++; throw full(); }
        }
        if (signal?.aborted) throw canceled(signal);
        // Include Redis acquisition in the queue budget, but preserve immediate
        // admission when queueing is disabled (waitMs === 0).
        if (waitMs > 0 && performance.now() >= deadline) { rejected++; throw full(); }
        processingStarted = performance.now();
        const result = await operation(); outcome = "completed"; return result;
      } finally {
        const ended = performance.now();
        const queueWaitMs = (processingStarted ?? ended) - started;
        const processingMs = processingStarted === undefined ? 0 : ended - processingStarted;
        timing[outcome]++; timing.queueWaitMs += queueWaitMs;
        timing.maxQueueWaitMs = Math.max(timing.maxQueueWaitMs, queueWaitMs);
        timing.processingMs += processingMs;
        const index = queue.indexOf(ticket); if (index >= 0) queue.splice(index, 1);
        // Release shared capacity before waking local successors.
        try { await release?.(); }
        finally {
          if (reserved) turns--;
          wake();
          try { onTiming?.({ queueWaitMs, processingMs, outcome }); } catch { /* Telemetry must not change call outcomes. */ }
        }
      }
    },
  };
  return admission;
};
