// CALLBACKIQ_PRODUCTION_HARDENING_V1
import mongoose from "mongoose";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export const normalizePageLimit = (
  value,
  { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {},
) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(parsed, maxLimit);
};

const encodeCursor = (value) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeCursor = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(String(value), "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") throw new Error("not object");
    return parsed;
  } catch {
    const error = new Error("Invalid pagination cursor");
    error.code = "INVALID_CURSOR";
    throw error;
  }
};

const requireObjectId = (value) => {
  if (!mongoose.isValidObjectId(value)) {
    const error = new Error("Invalid pagination cursor");
    error.code = "INVALID_CURSOR";
    throw error;
  }
  return new mongoose.Types.ObjectId(value);
};

const requireDate = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    const error = new Error("Invalid pagination cursor");
    error.code = "INVALID_CURSOR";
    throw error;
  }
  return date;
};

const finishPage = ({ documents, limit, cursorFor }) => {
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : documents;
  const last = items.at(-1);
  return {
    items,
    limit,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(cursorFor(last)) : null,
  };
};

export const setPaginationHeaders = (res, page) => {
  res.set("X-Page-Limit", String(page.limit));
  res.set("X-Has-More", page.hasMore ? "true" : "false");
  if (page.nextCursor) res.set("X-Next-Cursor", page.nextCursor);
};

export const getLeadsPage = async (businessId, query = {}) => {
  const limit = normalizePageLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const filter = { business: businessId };

  if (cursor) {
    const createdAt = requireDate(cursor.createdAt);
    const id = requireObjectId(cursor.id);
    filter.$or = [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: id } },
    ];
  }

  const documents = await Lead.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("business", "businessName businessType phone")
    .lean();

  return finishPage({
    documents,
    limit,
    cursorFor: (item) => ({
      createdAt: item.createdAt,
      id: String(item._id),
    }),
  });
};

export const getConversationsPage = async (businessId, query = {}) => {
  const limit = normalizePageLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const filter = { business: businessId };

  if (cursor) {
    const createdAt = requireDate(cursor.createdAt);
    const id = requireObjectId(cursor.id);

    if (cursor.lastMessageAt) {
      const lastMessageAt = requireDate(cursor.lastMessageAt);
      filter.$or = [
        { lastMessageAt: { $lt: lastMessageAt } },
        { lastMessageAt: null },
        { lastMessageAt, createdAt: { $lt: createdAt } },
        { lastMessageAt, createdAt, _id: { $lt: id } },
      ];
    } else {
      filter.$or = [
        { lastMessageAt: null, createdAt: { $lt: createdAt } },
        { lastMessageAt: null, createdAt, _id: { $lt: id } },
      ];
    }
  }

  const documents = await Conversation.find(filter)
    .sort({ lastMessageAt: -1, createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("business", "businessName phone owner")
    .populate("lead", "customerName phone serviceNeeded urgency status")
    .populate("archivedBy", "userName email role")
    .lean();

  return finishPage({
    documents,
    limit,
    cursorFor: (item) => ({
      lastMessageAt: item.lastMessageAt || null,
      createdAt: item.createdAt,
      id: String(item._id),
    }),
  });
};

export const getMessagesPage = async (conversationId, query = {}) => {
  const limit = normalizePageLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const filter = { conversation: conversationId };

  if (cursor) {
    const createdAt = requireDate(cursor.createdAt);
    const id = requireObjectId(cursor.id);
    filter.$or = [
      { createdAt: { $gt: createdAt } },
      { createdAt, _id: { $gt: id } },
    ];
  }

  const documents = await Message.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit + 1)
    .populate("lead", "customerName phone serviceNeeded")
    .populate("conversation", "customerPhone customerName status")
    .lean();

  return finishPage({
    documents,
    limit,
    cursorFor: (item) => ({
      createdAt: item.createdAt,
      id: String(item._id),
    }),
  });
};

export default {
  normalizePageLimit,
  setPaginationHeaders,
  getLeadsPage,
  getConversationsPage,
  getMessagesPage,
};
