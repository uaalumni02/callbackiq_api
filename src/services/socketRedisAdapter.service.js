import { safeConsole } from "../helpers/logging/safeLogger.js";
import { redisOptions, withDeadline } from "./boundedRedis.service.js";
let pubClient = null;
let subClient = null;

const redisUrl = () =>
  String(
    process.env.SOCKET_REDIS_URL ||
      process.env.REDIS_URL ||
      "",
  ).trim();

const redisRequired = () =>
  String(process.env.SOCKET_REDIS_REQUIRED || "").toLowerCase() === "true";

export const initializeSocketRedisAdapter = async (io) => {
  const url = redisUrl();

  if (!url) {
    if (redisRequired()) {
      throw new Error(
        "SOCKET_REDIS_REQUIRED=true but SOCKET_REDIS_URL/REDIS_URL is not configured.",
      );
    }
    safeConsole.log(
      "Socket.IO Redis adapter disabled; using single-instance realtime mode.",
    );
    return { enabled: false };
  }

  const [{ createAdapter }, { createClient }] = await Promise.all([
    import("@socket.io/redis-adapter"),
    import("redis"),
  ]);

  pubClient = createClient(redisOptions(url));
  subClient = pubClient.duplicate();

  const report = (label) => (error) =>
    safeConsole.error(`Socket Redis ${label} error:`, error);
  pubClient.on("error", report("publisher"));
  subClient.on("error", report("subscriber"));

  try {
    await withDeadline(Promise.all([pubClient.connect(), subClient.connect()]), 3000, "SOCKET_REDIS_STARTUP_TIMEOUT");
  } catch (error) {
    pubClient.destroy(); subClient.destroy(); throw error;
  }
  io.adapter(createAdapter(pubClient, subClient, { key: process.env.SOCKET_REDIS_CHANNEL_PREFIX || "socket.io" }));

  safeConsole.log("Socket.IO Redis adapter enabled.");
  return { enabled: true };
};

export const closeSocketRedisAdapter = async () => {
  const clients = [subClient, pubClient].filter(Boolean);
  subClient = null;
  pubClient = null;
  await Promise.all(
    clients.map(async (client) => {
      try {
        if (client.isOpen) await withDeadline(client.quit(), 1000);
      } catch (error) {
        try { client.destroy(); } catch {}
        safeConsole.error("Socket Redis shutdown error:", error);
      }
    }),
  );
};

export default {
  initializeSocketRedisAdapter,
  closeSocketRedisAdapter,
};

export const socketRedisReady = () => !redisRequired() || Boolean(pubClient?.isReady && subClient?.isReady);
