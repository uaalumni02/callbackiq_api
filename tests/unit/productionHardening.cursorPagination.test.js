import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));
jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));
jest.mock("../../src/models/message.js", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

import {
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
