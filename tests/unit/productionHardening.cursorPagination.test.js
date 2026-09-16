import Lead from "../../src/models/lead.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { find: jest.fn(), aggregate: jest.fn(), collection: { name: "leads" } },
}));
jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { find: jest.fn(), aggregate: jest.fn() },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { find: jest.fn(), aggregate: jest.fn(), populate: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

import {
  getCallLogsPage,
  getCallLogsOverview,
  getLeadsOverview,
  getConversationsPage,
  getLeadsPage,
  getMessagesPage,
  normalizePageLimit,
  setPaginationHeaders,
} from "../../src/services/cursorPagination.service.js";

const id = (n) => n.toString(16).padStart(24, "0");

const makeChain = (documents) => {
  const chain = {
    sort: jest.fn(),
    limit: jest.fn(),
    populate: jest.fn(),
    maxTimeMS: jest.fn(),
    lean: jest.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.populate.mockReturnValue(chain);
  chain.maxTimeMS.mockReturnValue(chain);
  chain.lean.mockResolvedValue(documents);
  return chain;
};

describe("cursor pagination", () => {
  beforeEach(() => jest.clearAllMocks());

  test("normalizes limits and enforces hard maximum", () => {
    expect(normalizePageLimit(undefined)).toBe(100);
    expect(normalizePageLimit("0")).toBe(100);
    expect(normalizePageLimit("25")).toBe(25);
    expect(normalizePageLimit("999")).toBe(200);
  });

  test("paginates leads with a stable cursor", async () => {
    const documents = [
      { _id: id(3), createdAt: new Date("2026-01-03") },
      { _id: id(2), createdAt: new Date("2026-01-02") },
      { _id: id(1), createdAt: new Date("2026-01-01") },
    ];
    const query = makeChain(documents);
    Lead.find.mockReturnValue(query);

    const first = await getLeadsPage("biz", { limit: "2" });
    expect(first.items).toHaveLength(2);
    expect(query.maxTimeMS).toHaveBeenCalledWith(3000);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    Lead.find.mockReturnValue(makeChain([]));
    await getLeadsPage("biz", { limit: "2", cursor: first.nextCursor });
    expect(Lead.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        business: "biz",
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.any(Array),
          }),
        ]),
      }),
    );
  });

  test("paginates conversations using last-message ordering", async () => {
    const documents = [
      {
        _id: id(3),
        createdAt: new Date("2026-01-03"),
        lastMessageAt: new Date("2026-02-03"),
      },
      {
        _id: id(2),
        createdAt: new Date("2026-01-02"),
        lastMessageAt: new Date("2026-02-02"),
      },
      {
        _id: id(1),
        createdAt: new Date("2026-01-01"),
        lastMessageAt: null,
      },
    ];
    Conversation.find.mockReturnValue(makeChain(documents));

    const page = await getConversationsPage("biz", { limit: "2" });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));

    Conversation.find.mockReturnValue(makeChain([]));
    await getConversationsPage("biz", {
      limit: "2",
      cursor: page.nextCursor,
    });
    expect(Conversation.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ $or: expect.any(Array) }),
    );
  });

  test("paginates messages forward in chronological order", async () => {
    const documents = [
      { _id: id(1), createdAt: new Date("2026-01-01") },
      { _id: id(2), createdAt: new Date("2026-01-02") },
    ];
    Message.find.mockReturnValue(makeChain(documents));

    const page = await getMessagesPage("conversation", { limit: "1" });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);

    Message.find.mockReturnValue(makeChain([]));
    await getMessagesPage("conversation", {
      limit: "1",
      cursor: page.nextCursor,
    });
    expect(Message.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ $or: expect.any(Array) }),
    );
  });

  test("rejects malformed cursors", async () => {
    Lead.find.mockReturnValue(makeChain([]));
    await expect(
      getLeadsPage("biz", { cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  test("sets backward-compatible pagination headers", () => {
    const res = { set: jest.fn() };
    setPaginationHeaders(res, {
      limit: 50,
      hasMore: true,
      nextCursor: "next",
    });
    expect(res.set).toHaveBeenCalledWith("X-Page-Limit", "50");
    expect(res.set).toHaveBeenCalledWith("X-Has-More", "true");
    expect(res.set).toHaveBeenCalledWith("X-Next-Cursor", "next");
  });
});

// Exercise page contracts with database calls stubbed at the model boundary.
// The production pagination functions and cursor encoding execute unchanged.
describe("scale pagination read contracts", () => {
  const business = id(90);
  const cursor = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const timestamp = new Date("2026-09-01T12:00:00Z");
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ["q", "repair.*"],
    ["search", "repair.*"],
    ["q", "x".repeat(220)],
  ])("lead %s searches remain literal, bounded and tenant scoped", async (key, input) => {
    Lead.find.mockReturnValue(makeChain([]));
    await getLeadsPage(business, { [key]: input, status: "new" });
    const filter = Lead.find.mock.calls[0][0];
    expect(filter.business).toBe(business);
    expect(filter.status).toBe("new");
    expect(filter.$and[0].$or).toHaveLength(7);
    const pattern = filter.$and[0].$or[0].customerName;
    expect(pattern.source).toBe(input === "repair.*" ? "repair\\.\\*" : "x".repeat(200));
    expect(pattern.flags).toBe("i");
  });

  test("call-log cursor retains search, status, direction and tenant boundaries", async () => {
    const rows = [{ _id: id(2), createdAt: timestamp }, { _id: id(1), createdAt: timestamp }];
    const chain = makeChain(rows);
    CallLog.find.mockReturnValue(chain);
    const page = await getCallLogsPage(business, { q: "repair.*", status: "missed", direction: "inbound", limit: 1 });
    expect(page.items).toEqual([rows[0]]);
    expect(page.hasMore).toBe(true);
    expect(chain.limit).toHaveBeenCalledWith(2);
    expect(chain.maxTimeMS).toHaveBeenCalledWith(3000);
    CallLog.find.mockReturnValue(makeChain([]));
    await getCallLogsPage(business, { search: "repair.*", status: "missed", direction: "inbound", limit: 1, cursor: page.nextCursor });
    const filter = CallLog.find.mock.calls[1][0];
    expect(filter).toMatchObject({ business, deletedAt: null, status: "missed", direction: "inbound" });
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and[0].$or[0].from.source).toBe("repair\\.\\*");
    expect(filter.$and[1].$or[0]).toEqual({ createdAt: { $lt: timestamp } });
    expect(String(filter.$and[1].$or[1]._id.$lt)).toBe(id(2));
  });

  test("empty call-log pages omit invalid filters and continuation", async () => {
    CallLog.find.mockReturnValue(makeChain([]));
    expect(await getCallLogsPage(business)).toEqual({ items: [], limit: 50, hasMore: false, nextCursor: null });
    await getCallLogsPage(business, { status: "unknown", direction: "unknown", search: "   " });
    expect(CallLog.find).toHaveBeenLastCalledWith({ business, deletedAt: null });
  });

  test.each([
    ["leads", Lead, getLeadsOverview],
    ["calls", CallLog, getCallLogsOverview],
  ])("%s overview bounds both reads and preserves historical totals", async (_, model, overview) => {
    model.find.mockReturnValue(makeChain([]));
    const option = jest.fn().mockResolvedValue([{ total: 8000 }]);
    model.aggregate.mockReturnValue({ option });
    const result = await overview(business);
    expect(result.items).toEqual([]);
    expect(result.pagination).toEqual({ limit: 50, hasMore: false, nextCursor: null });
    expect(result.stats.total).toBe(8000);
    expect(model.aggregate.mock.calls[0][0][0].$match.business).toBe(business);
    expect(option).toHaveBeenCalledWith({ maxTimeMS: 3000 });
    option.mockResolvedValue([]);
    expect((await overview(business)).stats.total).toBe(0);
  });

  test.each([null, "bad-id", "bad-date", "missing-date"])("rejects invalid cursor payload %s before reading", async (invalid) => {
    const value = invalid === null ? null : {
      id: invalid === "bad-id" ? "bad" : id(1),
      createdAt: invalid === "missing-date" ? undefined : invalid === "bad-date" ? "bad" : timestamp,
    };
    await expect(getLeadsPage(business, { cursor: cursor(value) })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(Lead.find).not.toHaveBeenCalled();
  });

  test("conversations without messages continue through the null-date group", async () => {
    const rows = [{ _id: id(2), createdAt: timestamp }, { _id: id(1), createdAt: timestamp }];
    Conversation.find.mockReturnValue(makeChain(rows));
    const page = await getConversationsPage(business, { limit: 1 });
    expect(JSON.parse(Buffer.from(page.nextCursor, "base64url"))).toEqual({ id: id(2), createdAt: timestamp.toISOString(), lastMessageAt: null });
    Conversation.find.mockReturnValue(makeChain([]));
    await getConversationsPage(business, { limit: 1, cursor: page.nextCursor });
    const filter = Conversation.find.mock.calls[1][0];
    expect(filter.business).toBe(business);
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]).toEqual({ lastMessageAt: null, createdAt: { $lt: timestamp } });
    expect(String(filter.$or[1]._id.$lt)).toBe(id(2));
    await getConversationsPage(business);
  });

  test.each(["q", "search"])("conversation %s search bounds results and joins only the tenant's leads", async (key) => {
    const row = { _id: id(2), createdAt: timestamp, lastMessageAt: timestamp };
    const option = jest.fn().mockResolvedValue([row, { ...row, _id: id(1) }]);
    Conversation.aggregate.mockReturnValue({ option });
    Conversation.populate.mockImplementation(async (rows) => rows);
    const result = await getConversationsPage(business, { [key]: "repair.*", limit: 1, status: "open" });
    expect(result.items).toEqual([row]);
    expect(result.hasMore).toBe(true);
    const pipeline = Conversation.aggregate.mock.calls[0][0];
    expect(String(pipeline[0].$match.business)).toBe(business);
    expect(pipeline[0].$match.status).toBe("open");
    expect(pipeline.find(stage => stage.$limit)).toEqual({ $limit: 2 });
    const alternatives = pipeline.find(stage => stage.$match?.$or).$match.$or;
    expect(alternatives[0].customerName.source).toBe("repair\\.\\*");
    expect(String(alternatives[2].searchLead.$elemMatch.business)).toBe(business);
    expect(option).toHaveBeenCalledWith({ maxTimeMS: 3000 });
    expect(Conversation.populate).toHaveBeenCalledWith(expect.any(Array), expect.arrayContaining([expect.objectContaining({ path: "lead" })]));
    expect(Conversation.find).not.toHaveBeenCalled();
  });

  test("default message page and final-page headers omit continuation", async () => {
    Message.find.mockReturnValue(makeChain([]));
    const page = await getMessagesPage(id(1));
    expect(page).toEqual({ items: [], limit: 100, hasMore: false, nextCursor: null });
    const response = { set: jest.fn() };
    setPaginationHeaders(response, page);
    expect(response.set.mock.calls).toEqual([["X-Page-Limit", "100"], ["X-Has-More", "false"]]);
    Lead.find.mockReturnValue(makeChain([]));
    await getLeadsPage(business);
  });
});
