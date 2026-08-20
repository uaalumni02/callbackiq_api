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
    console.log(
      "Socket.IO Redis adapter disabled; using single-instance realtime mode.",
    );
    return { enabled: false };
  }

  const [{ createAdapter }, { createClient }] = await Promise.all([
    import("@socket.io/redis-adapter"),
    import("redis"),
  ]);

  pubClient = createClient({ url });
  subClient = pubClient.duplicate();

  const report = (label) => (error) =>
    console.error(`Socket Redis ${label} error:`, error);
  pubClient.on("error", report("publisher"));
  subClient.on("error", report("subscriber"));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  console.log("Socket.IO Redis adapter enabled.");
  return { enabled: true };
};

export const closeSocketRedisAdapter = async () => {
  const clients = [subClient, pubClient].filter(Boolean);
  subClient = null;
  pubClient = null;
  await Promise.all(
    clients.map(async (client) => {
      try {
        if (client.isOpen) await client.quit();
      } catch (error) {
        console.error("Socket Redis shutdown error:", error);
      }
    }),
  );
};

export default {
  initializeSocketRedisAdapter,
  closeSocketRedisAdapter,
};
