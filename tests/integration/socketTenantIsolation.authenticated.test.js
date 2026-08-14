import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { io as createSocketClient } from "socket.io-client";

jest.mock("../../src/helpers/jwt/token.js", () => ({
  __esModule: true,
  default: {
    verify: jest.fn(),
  },
}));

jest.mock("../../src/models/user.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
  },
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

import token from "../../src/helpers/jwt/token.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import socketAuth from "../../src/middleware/socket-auth.js";
import SocketService from "../../src/services/socket.service.js";

const mockVerifyToken = token.verify;
const mockUserFindById = User.findById;
const mockBusinessFindOne = Business.findOne;

const leanQuery = (value) => {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn().mockResolvedValue(value),
  };
  return query;
};

const connect = (url, token) =>
  new Promise((resolve, reject) => {
    const client = createSocketClient(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`Timed out connecting token ${token}`));
    }, 3000);
    client.once("test:ready", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

describe("authenticated Socket.IO tenant isolation", () => {
  let httpServer;
  let io;
  let baseUrl;
  const clients = [];

  beforeAll(async () => {
    httpServer = http.createServer();
    io = new SocketIOServer(httpServer, {
      cors: { origin: true, credentials: true },
    });
    io.use(socketAuth);
    io.on("connection", (socket) => {
      // Exercise the real authentication middleware and derive tenant identity
      // only from server-side state established by that middleware. Never trust
      // a client-supplied room or business identifier.
      const businessCandidate =
        socket.data?.businessId ??
        socket.businessId ??
        socket.business?._id ??
        socket.data?.business?._id ??
        socket.user?.business?._id ??
        socket.user?.business ??
        socket.data?.user?.business?._id ??
        socket.data?.user?.business;
      const businessId = businessCandidate ? String(businessCandidate) : "";

      if (!businessId) {
        socket.emit("test:auth-context-missing");
        socket.disconnect(true);
        return;
      }

      socket.join(`business:${businessId}`);
      socket.emit("test:ready", { businessId });
    });
    SocketService.initialize(io);

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockVerifyToken.mockImplementation((token) => {
      if (token === "token-A") return { userId: "user-A" };
      if (token === "token-B") return { userId: "user-B" };
      throw Object.assign(new Error("invalid"), { name: "JsonWebTokenError" });
    });

    mockUserFindById.mockImplementation((id) =>
      leanQuery({
        _id: id,
        userName: id,
        email: `${id}@example.com`,
        role: "owner",
        businessName: id === "user-A" ? "Business A" : "Business B",
      }),
    );

    mockBusinessFindOne.mockImplementation(({ owner }) =>
      leanQuery({
        _id: owner === "user-A" ? "business-A" : "business-B",
        businessName: owner === "user-A" ? "Business A" : "Business B",
        isActive: true,
        owner,
      }),
    );
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

  test("authenticates each owner into only the server-resolved business room", async () => {
    const a = await connect(baseUrl, "token-A");
    const b = await connect(baseUrl, "token-B");
    clients.push(a, b);

    let leakedToB = false;
    b.on("lead:created", () => {
      leakedToB = true;
    });
    const receivedByA = new Promise((resolve) => a.once("lead:created", resolve));

    SocketService.emitLeadCreated("business-A", {
      _id: "lead-A",
      business: "business-A",
    });

    await expect(receivedByA).resolves.toMatchObject({ _id: "lead-A" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(leakedToB).toBe(false);

    let leakedToA = false;
    a.on("message:created", () => {
      leakedToA = true;
    });
    const receivedByB = new Promise((resolve) =>
      b.once("message:created", resolve),
    );

    SocketService.emitMessageCreated("business-B", {
      _id: "message-B",
      business: "business-B",
    });

    await expect(receivedByB).resolves.toMatchObject({ _id: "message-B" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(leakedToA).toBe(false);
  });

  test("rejects an invalid token before any business room is joined", async () => {
    await expect(connect(baseUrl, "invalid-token")).rejects.toMatchObject({
      message: expect.any(String),
    });
  });
});
