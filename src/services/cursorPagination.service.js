// CALLBACKIQ_PRODUCTION_HARDENING_V1
import mongoose from "mongoose";
import Lead from "../models/lead.js";
import CallLog from "../models/callLog.js";
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

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");

const paginationMeta = (page) => ({
  limit: page.limit,
  hasMore: page.hasMore,
  nextCursor: page.nextCursor,
});

export const getLeadsPage = async (businessId, query = {}) => {
  const limit = normalizePageLimit(query.limit, { defaultLimit: 50, maxLimit: 200 });
  const cursor = decodeCursor(query.cursor);
  const filter = { business: businessId };
  const clauses = [];

  if (["new", "contacted", "booked", "lost", "spam"].includes(query.status)) {
    filter.status = query.status;
  }

  const search = String(query.q || query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    clauses.push({
      $or: [
        { customerName: pattern },
        { phone: pattern },
        { serviceNeeded: pattern },
        { "firstAttribution.sourceName": pattern },
        { "firstAttribution.campaign": pattern },
        { "latestAttribution.sourceName": pattern },
        { "latestAttribution.campaign": pattern },
      ],
    });
  }

  if (cursor) {
    const createdAt = requireDate(cursor.createdAt);
    const id = requireObjectId(cursor.id);
    clauses.push({
      $or: [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: id } },
      ],
    });
  }

  if (clauses.length) filter.$and = clauses;

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

export const getLeadsOverview = async (businessId, query = {}) => {
  const [page, summaryRows] = await Promise.all([
    getLeadsPage(businessId, query),
    Lead.aggregate([
      { $match: { business: businessId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          new: { $sum: { $cond: [{ $eq: ["$status", "new"] }, 1, 0] } },
          contacted: {
            $sum: { $cond: [{ $eq: ["$status", "contacted"] }, 1, 0] },
          },
          booked: { $sum: { $cond: [{ $eq: ["$status", "booked"] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$status", "lost"] }, 1, 0] } },
          spam: { $sum: { $cond: [{ $eq: ["$status", "spam"] }, 1, 0] } },
          estimatedValue: { $sum: "$estimatedValue" },
          actualRevenue: { $sum: "$actualRevenue" },
        },
      },
    ]),
  ]);

  return {
    items: page.items,
    pagination: paginationMeta(page),
    stats: summaryRows[0] || {
      total: 0,
      new: 0,
      contacted: 0,
      booked: 0,
      lost: 0,
      spam: 0,
      estimatedValue: 0,
      actualRevenue: 0,
    },
  };
};

export const getCallLogsPage = async (businessId, query = {}) => {
  const limit = normalizePageLimit(query.limit, { defaultLimit: 50, maxLimit: 200 });
  const cursor = decodeCursor(query.cursor);
  const filter = { business: businessId, deletedAt: null };
  const clauses = [];

  const validStatuses = new Set([
    "answered",
    "missed",
    "voicemail",
    "failed",
    "busy",
    "no_answer",
  ]);
  if (validStatuses.has(query.status)) filter.status = query.status;
  if (["inbound", "outbound"].includes(query.direction)) {
    filter.direction = query.direction;
  }

  const search = String(query.q || query.search || "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    clauses.push({
      $or: [
        { from: pattern },
        { to: pattern },
        { status: pattern },
        { provider: pattern },
        { notes: pattern },
        { transcription: pattern },
        { "attribution.sourceName": pattern },
        { "attribution.channel": pattern },
        { "attribution.campaign": pattern },
        { "attribution.trackingNumber": pattern },
      ],
    });
  }

  if (cursor) {
    const createdAt = requireDate(cursor.createdAt);
    const id = requireObjectId(cursor.id);
    clauses.push({
      $or: [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: id } },
      ],
    });
  }

  if (clauses.length) filter.$and = clauses;

  const documents = await CallLog.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate(
      "lead",
      "customerName phone estimatedValue actualRevenue firstAttribution latestAttribution source",
    )
    .populate("conversation", "customerName customerPhone status")
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

export const getCallLogsOverview = async (businessId, query = {}) => {
  const [page, summaryRows] = await Promise.all([
    getCallLogsPage(businessId, query),
    CallLog.aggregate([
      { $match: { business: businessId, deletedAt: null } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          missed: {
            $sum: {
              $cond: [
                { $in: ["$status", ["missed", "voicemail", "failed", "busy", "no_answer"]] },
                1,
                0,
              ],
            },
          },
          answered: {
            $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] },
          },
          recovered: { $sum: { $cond: ["$recovered", 1, 0] } },
        },
      },
    ]),
  ]);

  return {
    items: page.items,
    pagination: paginationMeta(page),
    stats: summaryRows[0] || {
      total: 0,
      missed: 0,
      answered: 0,
      recovered: 0,
    },
  };
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

export const getMessagesPage = async (
  conversationId,
  query = {},
  { conversation = null } = {},
) => {
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

  const messageQuery = Message.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit + 1)
    .populate("lead", "customerName phone serviceNeeded");

  /*
   * If the controller has already authorized and loaded the Conversation,
   * do not query it again through populate().
   */
  if (!conversation) {
    messageQuery.populate(
      "conversation",
      "customerPhone customerName status",
    );
  }

  const documents = await messageQuery.lean();

  const conversationSummary = conversation
    ? {
        _id: conversation._id,
        customerPhone: conversation.customerPhone,
        customerName: conversation.customerName,
        status: conversation.status,
      }
    : null;

  const responseDocuments = conversationSummary
    ? documents.map((message) => ({
        ...message,
        conversation: conversationSummary,
      }))
    : documents;

  return finishPage({
    documents: responseDocuments,
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
  getLeadsOverview,
  getCallLogsPage,
  getCallLogsOverview,
  getConversationsPage,
  getMessagesPage,
};
