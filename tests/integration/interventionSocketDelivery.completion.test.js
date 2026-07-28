import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as createSocketClient } from "socket.io-client";

import Alert from "../../src/models/alert.js";
import InterventionService from "../../src/services/intervention.service.js";
import SocketService from "../../src/services/socket.service.js";

jest.mock("../../src/models/alert.js", () => ({
  __esModule: true,
  default: { create: jest.fn(), findById: jest.fn(), findOne: jest.fn() },
}));

const populatedQuery = (value) => {
  const query = {
    populate: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};

const connectClient = (url, businessId) =>
  new Promise((resolve, reject) => {
    const client = createSocketClient(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { businessId },
    });
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`Timed out connecting business ${businessId}`));
    }, 3000);
    client.once("test:room-ready", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

describe("Intervention Center Socket.IO delivery", () => {
  let httpServer;
  let io;
  let baseUrl;
  const clients = [];

  beforeAll(async () => {
    httpServer = http.createServer();
    io = new SocketIOServer(httpServer, {
      cors: { origin: true, credentials: true },
    });

    /*
     * Authentication and secure room selection are independently exercised by
     * socket-auth.full.test.js. This transport test uses a deterministic room
     * join so it can prove service -> Socket.IO room -> client delivery.
     */
    io.on("connection", async (socket) => {
      const businessId = String(socket.handshake.auth?.businessId || "").trim();
      if (businessId) await socket.join(`business:${businessId}`);
      socket.emit("test:room-ready");
    });

    SocketService.initialize(io);

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    while (clients.length) clients.pop().close();
  });

  afterAll(async () => {
    SocketService.reset();
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  test("creates, normalizes, and delivers an intervention to the matching business", async () => {
    const client = await connectClient(baseUrl, "business-1");
    clients.push(client);

    const populated = {
      _id: "alert-1",
      business: "business-1",
      type: "safety_emergency",
      priority: "critical",
      status: "sent",
    };
    Alert.create.mockResolvedValue({ _id: "alert-1" });
    Alert.findById.mockReturnValue(populatedQuery(populated));

    const created = new Promise((resolve) => client.once("alert:created", resolve));
    await expect(
      InterventionService.create({
        businessId: "business-1",
        type: "safety_emergency",
        title: "Immediate safety review",
        message: "A customer described immediate danger.",
        priority: "low",
      }),
    ).resolves.toEqual(populated);

    expect(Alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        business: "business-1",
        priority: "critical",
        actionRequired: true,
      }),
    );
    await expect(created).resolves.toMatchObject({
      _id: "alert-1",
      priority: "critical",
    });

    const updated = new Promise((resolve) => client.once("alert:updated", resolve));
    SocketService.emitAlertUpdated("business-1", {
      _id: "alert-1",
      status: "resolved",
    });
    await expect(updated).resolves.toMatchObject({
      _id: "alert-1",
      status: "resolved",
    });
  });

  test("does not leak generated intervention events into another business room", async () => {
    const first = await connectClient(baseUrl, "business-1");
    const second = await connectClient(baseUrl, "business-2");
    clients.push(first, second);

    let leaked = false;
    second.on("alert:created", () => {
      leaked = true;
    });

    const populated = {
      _id: "tenant-alert",
      business: "business-1",
      type: "human_requested",
      priority: "high",
    };
    Alert.create.mockResolvedValue({ _id: "tenant-alert" });
    Alert.findById.mockReturnValue(populatedQuery(populated));

    const received = new Promise((resolve) => first.once("alert:created", resolve));
    await InterventionService.create({
      businessId: "business-1",
      type: "human_requested",
      title: "Customer requested staff",
      message: "Please call the customer.",
      priority: "high",
    });

    await expect(received).resolves.toMatchObject({ _id: "tenant-alert" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(leaked).toBe(false);
  });
});
