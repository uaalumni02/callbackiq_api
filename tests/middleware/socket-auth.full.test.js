import socketAuth, {
  getBearerToken,
  getSocketToken,
  parseCookies,
} from "../../src/middleware/socket-auth.js";
import Token from "../../src/helpers/jwt/token.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";

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

const queryResult = (value) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(value),
  }),
});

const makeSocket = (overrides = {}) => ({
  handshake: {
    auth: {},
    headers: {},
    ...(overrides.handshake || {}),
  },
  data: {},
  join: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const errorCode = (next) => next.mock.calls[0]?.[0]?.data?.code;

describe("socket authentication middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("parses cookie, bearer, and socket token variants", () => {
    expect(parseCookies()).toEqual({});
    expect(parseCookies("bad-cookie; token=abc%20123; empty=")).toEqual({
      token: "abc 123",
      empty: "",
    });
    expect(getBearerToken("Bearer abc")).toBe("abc");
    expect(getBearerToken("bearer   spaced-token ")).toBe("spaced-token");
    expect(getBearerToken("Basic abc")).toBeNull();
    expect(getBearerToken(null)).toBeNull();

    expect(
      getSocketToken(
        makeSocket({ handshake: { auth: { token: " auth-token " }, headers: {} } }),
      ),
    ).toBe("auth-token");
    expect(
      getSocketToken(
        makeSocket({ handshake: { auth: {}, headers: { authorization: "Bearer header-token" } } }),
      ),
    ).toBe("header-token");
    expect(
      getSocketToken(
        makeSocket({ handshake: { auth: {}, headers: { cookie: "token=cookie-token" } } }),
      ),
    ).toBe("cookie-token");
  });

  test("rejects a connection without a token", async () => {
    const next = jest.fn();
    await socketAuth(makeSocket(), next);
    expect(errorCode(next)).toBe("SOCKET_AUTH_REQUIRED");
  });

  test("rejects a decoded token without a user ID", async () => {
    Token.verify.mockReturnValue({});
    const next = jest.fn();
    await socketAuth(
      makeSocket({ handshake: { auth: { token: "token" }, headers: {} } }),
      next,
    );
    expect(errorCode(next)).toBe("SOCKET_INVALID_TOKEN");
  });

  test.each(["TokenExpiredError", "JsonWebTokenError", "NotBeforeError"])(
    "maps %s to an invalid-token socket error",
    async (name) => {
      const error = new Error("invalid token");
      error.name = name;
      Token.verify.mockImplementation(() => {
        throw error;
      });
      const next = jest.fn();
      await socketAuth(
        makeSocket({ handshake: { auth: { token: "token" }, headers: {} } }),
        next,
      );
      expect(errorCode(next)).toBe("SOCKET_INVALID_TOKEN");
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  test("rejects a token for a deleted user", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(queryResult(null));
    const next = jest.fn();
    await socketAuth(
      makeSocket({ handshake: { auth: { token: "token" }, headers: {} } }),
      next,
    );
    expect(errorCode(next)).toBe("SOCKET_USER_NOT_FOUND");
  });

  test("authenticates an administrator and joins only user and role rooms", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(
      queryResult({ _id: "u1", userName: "Admin", email: "a@example.com", role: " ADMIN " }),
    );
    const socket = makeSocket({
      handshake: { auth: {}, headers: { authorization: "Bearer token" } },
    });
    const next = jest.fn();

    await socketAuth(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toEqual({
      userId: "u1",
      userName: "Admin",
      email: "a@example.com",
      role: "admin",
    });
    expect(socket.data.businessId).toBeNull();
    expect(socket.data.business).toBeNull();
    expect(socket.join.mock.calls).toEqual([["user:u1"], ["role:admin"]]);
    expect(Business.findOne).not.toHaveBeenCalled();
  });

  test("rejects members until explicit membership support exists", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(
      queryResult({ _id: "u1", role: "member", userName: "Member", email: "m@example.com" }),
    );
    const next = jest.fn();
    await socketAuth(
      makeSocket({ handshake: { auth: { token: "token" }, headers: {} } }),
      next,
    );
    expect(errorCode(next)).toBe("SOCKET_BUSINESS_MEMBERSHIP_REQUIRED");
  });

  test("rejects an owner without a business", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(
      queryResult({ _id: "u1", role: "owner", userName: "Owner", email: "o@example.com" }),
    );
    Business.findOne.mockReturnValue(queryResult(null));
    const next = jest.fn();
    await socketAuth(
      makeSocket({ handshake: { auth: { token: "token" }, headers: {} } }),
      next,
    );
    expect(errorCode(next)).toBe("SOCKET_BUSINESS_NOT_FOUND");
  });

  test("rejects an inactive owner business", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(
      queryResult({ _id: "u1", role: "owner", userName: "Owner", email: "o@example.com" }),
    );
    Business.findOne.mockReturnValue(
      queryResult({ _id: "b1", businessName: "Inactive", isActive: false, owner: "u1" }),
    );
    const next = jest.fn();
    await socketAuth(
      makeSocket({ handshake: { auth: { token: "token" }, headers: {} } }),
      next,
    );
    expect(errorCode(next)).toBe("SOCKET_BUSINESS_INACTIVE");
  });

  test("accepts an authenticated owner and attaches business context", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(
      queryResult({ _id: "u1", role: "owner", userName: "Owner", email: "o@example.com" }),
    );
    Business.findOne.mockReturnValue(
      queryResult({ _id: "b1", businessName: "Demo Business", isActive: true, owner: "u1" }),
    );
    const socket = makeSocket({
      handshake: { auth: {}, headers: { cookie: "token=token" } },
    });
    const next = jest.fn();

    await socketAuth(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toEqual(
      expect.objectContaining({ userId: "u1", role: "owner" }),
    );
    expect(socket.data.businessId).toBe("b1");
    expect(socket.data.business).toEqual({
      businessId: "b1",
      businessName: "Demo Business",
    });
    expect(socket.join.mock.calls).toEqual([
      ["user:u1"],
      ["role:owner"],
      ["business:b1"],
    ]);
  });

  test("maps unexpected join failures to SOCKET_AUTH_FAILED", async () => {
    Token.verify.mockReturnValue({ userId: "u1" });
    User.findById.mockReturnValue(
      queryResult({ _id: "u1", role: "admin", userName: "Admin", email: "a@example.com" }),
    );
    const socket = makeSocket({
      handshake: { auth: { token: "token" }, headers: {} },
      join: jest.fn().mockRejectedValue(new Error("join failed")),
    });
    const next = jest.fn();

    await socketAuth(socket, next);

    expect(errorCode(next)).toBe("SOCKET_AUTH_FAILED");
    expect(console.error).toHaveBeenCalledWith(
      "Socket authentication error:",
      expect.any(Error),
    );
  });
});
