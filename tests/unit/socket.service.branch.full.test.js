import SocketService, {
  normalizeId,
} from "../../src/services/socket.service.js";

const makeIo = () => {
  const emit = jest.fn();
  const room = { emit };
  return {
    io: { to: jest.fn(() => room) },
    emit,
  };
};

describe("SocketService branch coverage", () => {
  beforeEach(() => {
    SocketService.reset();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    SocketService.reset();
    jest.restoreAllMocks();
  });

  test.each([
    [null, null],
    [undefined, null],
    ["  abc  ", "abc"],
    ["   ", null],
    [42, "42"],
    [42n, "42"],
    [{ toHexString: () => "  deadbeef  " }, "deadbeef"],
    [{ _id: " nested " }, "nested"],
    [{ id: 7 }, "7"],
    [{ toString: () => "custom-id" }, "custom-id"],
    [{ toString: () => "[object Object]" }, null],
  ])("normalizes identifier %#", (value, expected) => {
    expect(normalizeId(value)).toBe(expected);
  });

  test("does not recurse into a self-referencing ID", () => {
    const value = { toString: () => "[object Object]" };
    value._id = value;
    expect(normalizeId(value)).toBeNull();
  });

  test("validates initialization and exposes initialization state", () => {
    expect(SocketService.isInitialized()).toBe(false);
    expect(SocketService.getIo()).toBeNull();
    expect(() => SocketService.initialize()).toThrow(
      "A valid Socket.IO server instance is required for initialization.",
    );
    expect(() => SocketService.initialize({})).toThrow(
      "A valid Socket.IO server instance is required for initialization.",
    );

    const { io } = makeIo();
    expect(SocketService.initialize(io)).toBe(io);
    expect(SocketService.isInitialized()).toBe(true);
    expect(SocketService.getIo()).toBe(io);
  });

  test("returns false before initialization and warns only once", () => {
    expect(SocketService.emitToAdmins("event", {})).toBe(false);
    expect(SocketService.emitToAdmins("event", {})).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  test("validates room identifiers and event names", () => {
    const { io, emit } = makeIo();
    SocketService.initialize(io);

    expect(SocketService.emitToBusiness(null, "event", {})).toBe(false);
    expect(SocketService.emitToUser("", "event", {})).toBe(false);
    expect(SocketService.emitToAdmins("   ", {})).toBe(false);
    expect(SocketService.emitToAdmins(null, {})).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    expect(SocketService.emitToBusiness("b1", " business:event ", { ok: true })).toBe(true);
    expect(io.to).toHaveBeenCalledWith("business:b1");
    expect(emit).toHaveBeenCalledWith("business:event", { ok: true });

    expect(SocketService.emitToUser({ _id: "u1" }, "user:event", null)).toBe(true);
    expect(io.to).toHaveBeenCalledWith("user:u1");

    expect(SocketService.emitToAdmins("admin:event", { id: 1 })).toBe(true);
    expect(io.to).toHaveBeenCalledWith("role:admin");
  });

  test("exercises every public event wrapper", () => {
    const { io, emit } = makeIo();
    SocketService.initialize(io);

    const calls = [
      () => SocketService.emitDashboardRefresh("b1"),
      () => SocketService.emitDashboardRefresh("b1", "manual"),
      () => SocketService.emitLeadCreated("b1", { _id: "l1" }),
      () => SocketService.emitLeadUpdated("b1", { _id: "l1" }),
      () => SocketService.emitConversationCreated("b1", { _id: "c1" }),
      () => SocketService.emitConversationUpdated("b1", { _id: "c1" }),
      () => SocketService.emitMessageCreated("b1", { _id: "m1" }),
      () => SocketService.emitMessageUpdated("b1", { _id: "m1" }),
      () => SocketService.emitCallCreated("b1", { _id: "call1" }),
      () => SocketService.emitCallUpdated("b1", { _id: "call1" }),
      () => SocketService.emitAlertCreated("b1", { _id: "a1" }),
      () => SocketService.emitAlertUpdated("b1", { _id: "a1" }),
      () => SocketService.emitAlertDeleted("b1", { _id: "a1" }),
      () => SocketService.emitAllAlertsRead("b1"),
      () => SocketService.emitAllAlertsRead("b1", { readAt: "fixed" }),
      () => SocketService.emitConversationIntelligenceUpdated("b1", { _id: "ci1" }),
      () => SocketService.emitConversationIntelligenceDeleted("b1", { _id: "c1" }),
    ];

    for (const call of calls) {
      expect(call()).toBe(true);
    }

    expect(emit).toHaveBeenCalledTimes(calls.length);
    expect(emit).toHaveBeenCalledWith(
      "alert:deleted",
      expect.objectContaining({ alertId: "a1", deletedAt: expect.any(String) }),
    );
    expect(emit).toHaveBeenCalledWith(
      "alerts:all_read",
      expect.objectContaining({ readAt: expect.any(String) }),
    );
    expect(emit).toHaveBeenCalledWith(
      "conversation-intelligence:deleted",
      expect.objectContaining({ conversationId: "c1" }),
    );
  });
});
