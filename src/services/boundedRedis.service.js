import { createClient } from "redis";
import { logOperationalWarning } from "../helpers/logging/safeLogger.js";

export const withDeadline = (operation, ms, code = "DEPENDENCY_TIMEOUT") => {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export const redisOptions = (url) => ({
  url,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1000,
  socket: { connectTimeout: 1000, reconnectStrategy: (attempt) => Math.min(3000, 100 * 2 ** Math.min(attempt, 5)) },
});

// Each purpose has its own connection and circuit. Cache failures must not
// fill the coordination/publisher command queues.
export const createBoundedRedis = ({ url, timeoutMs = 200, cooldownMs = 5000, name = "redis" }) => {
  let client;
  let connecting;
  let retryAt = 0;
  const destroy = () => {
    const previous = client;
    client = null;
    connecting = null;
    try { previous?.destroy(); } catch { /* Already closed. */ }
  };
  const execute = async (operation) => {
    if (!url()) throw Object.assign(new Error("Redis is not configured"), { code: "REDIS_UNCONFIGURED" });
    if (Date.now() < retryAt) throw Object.assign(new Error("Redis circuit open"), { code: "REDIS_CIRCUIT_OPEN" });
    let current;
    try {
      if (!client) {
        client = createClient(redisOptions(url()));
        client.on("error", () => {}); // Rejections are logged once per circuit below.
      }
      current = client;
      if (!current.isReady) {
        if (!connecting) connecting = current.connect();
        await withDeadline(connecting, timeoutMs, "REDIS_CONNECT_TIMEOUT");
        connecting = null;
      }
      return await withDeadline(operation(current), timeoutMs, "REDIS_COMMAND_TIMEOUT");
    } catch (error) {
      if (current === client) {
        retryAt = Date.now() + cooldownMs;
        destroy();
        logOperationalWarning("redis.circuit_open", { purpose: name, code: error.code });
      }
      throw error;
    }
  };
  return { execute, close: () => { destroy(); retryAt = 0; }, ready: () => Boolean(client?.isReady) };
};
