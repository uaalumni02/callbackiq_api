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
  let waiting = 0;
  let pending = 0, sessions = 0, turns = 0, draining = false, rejected = 0;
  const full = () => Object.assign(new Error("Voice turn capacity reached"), { code: "VOICE_ADMISSION_FULL" });
  const pause = (signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason || Object.assign(new Error("Turn canceled"), { code: "VOICE_STALE_TURN" })); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 25);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  return {
    drain: () => { draining = true; },
    snapshot: () => ({ pending, sessions, turns, waiting, draining, rejected, limits }),
    acquireConnection: () => {
      if (draining || pending >= limits.pending || sessions + pending >= limits.sessions) { rejected++; return null; }
      pending++;
      let state = "pending";
      return {
        activate: () => { if (state === "pending") { pending--; sessions++; state = "active"; } },
        release: () => { if (state === "pending") pending--; if (state === "active") sessions--; state = "released"; },
      };
    },
    runTurn: async (operation, { signal } = {}) => {
      const deadline = Date.now() + waitMs;
      let queued = false;
      try {
        while (true) {
          if (signal?.aborted) throw signal.reason || Object.assign(new Error("Turn canceled"), { code: "VOICE_STALE_TURN" });
          if (turns < limits.turns) {
            turns++;
            let release;
            try {
              try { release = await acquireFleetVoiceSlot("turns"); }
              catch (error) { if (error.code !== "VOICE_ADMISSION_FULL") throw error; }
              if (release) {
                if (queued) { waiting--; queued = false; }
                if (signal?.aborted) throw signal.reason;
                return await operation();
              }
            } finally { turns--; await release?.(); }
          }
          if (Date.now() >= deadline) { rejected++; throw full(); }
          if (!queued) {
            if (waiting >= maxWaiting) { rejected++; throw full(); }
            waiting++; queued = true;
          }
          await pause(signal);
        }
      } finally { if (queued) waiting--; }
    },
  };
};
