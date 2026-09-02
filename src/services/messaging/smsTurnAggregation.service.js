import Message from "../../models/message.js";
import SmsProcessingJob from "../../models/smsProcessingJob.js";

const positive = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const historyLimit = () => positive(process.env.SMS_AI_HISTORY_MESSAGES, 20, 60);
const maxTurnMessages = () => positive(process.env.SMS_TURN_MAX_MESSAGES, 8, 20);
const maxTurnCharacters = () => positive(process.env.SMS_TURN_MAX_CHARACTERS, 3200, 8000);
const bodyOf = (message) => String(message?.body || "").trim();

export const loadCustomerTurn = async ({ conversationId, anchorMessage }) => {
  if (!conversationId || !anchorMessage?._id) {
    throw new Error("conversationId and anchorMessage are required");
  }

  const lastOutbound = await Message.findOne({
    conversation: conversationId,
    direction: "outbound",
  })
    .sort({ createdAt: -1, _id: -1 })
    .select("_id createdAt")
    .lean();

  const inboundFilter = {
    conversation: conversationId,
    direction: "inbound",
    ...(lastOutbound?.createdAt ? { createdAt: { $gt: lastOutbound.createdAt } } : {}),
  };

  const inbound = await Message.find(inboundFilter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(maxTurnMessages())
    .lean();

  const selected = [];
  let characters = 0;
  for (const message of inbound) {
    const body = bodyOf(message);
    if (!body) continue;
    const next = characters + body.length + (selected.length ? 1 : 0);
    if (selected.length && next > maxTurnCharacters()) break;
    selected.push(message);
    characters = next;
  }

  if (!selected.some((message) => String(message._id) === String(anchorMessage._id))) {
    selected.push(anchorMessage.toObject ? anchorMessage.toObject() : anchorMessage);
  }

  selected.sort((a, b) => {
    const time = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    return time || String(a._id).localeCompare(String(b._id));
  });

  const customerMessage = selected.map(bodyOf).filter(Boolean).join("\n");
  const firstTurnAt = selected[0]?.createdAt || anchorMessage.createdAt || new Date();

  const history = await Message.find({
    conversation: conversationId,
    createdAt: { $lt: firstTurnAt },
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(historyLimit())
    .lean();

  history.reverse();

  const syntheticInbound = {
    ...(anchorMessage.toObject ? anchorMessage.toObject() : anchorMessage),
    body: customerMessage || bodyOf(anchorMessage),
    metadata: {
      ...(anchorMessage.metadata || {}),
      customerTurn: true,
      turnMessageIds: selected.map((message) => String(message._id)),
    },
  };

  return {
    customerMessage: syntheticInbound.body,
    turnMessages: selected,
    turnMessageIds: selected.map((message) => message._id),
    primaryInboundMessage: syntheticInbound,
    historyMessages: [...history, syntheticInbound],
  };
};

export const completeCoalescedJobs = async ({
  conversationId,
  primaryJobId,
  primaryMessageId,
  turnMessageIds = [],
}) => {
  const related = turnMessageIds.filter(
    (messageId) => String(messageId) !== String(primaryMessageId),
  );
  if (!related.length) return { modifiedCount: 0 };

  const now = new Date();
  const result = await SmsProcessingJob.updateMany(
    {
      conversation: conversationId,
      inboundMessage: { $in: related },
      status: { $in: ["queued", "retry"] },
    },
    {
      $set: {
        status: "completed",
        completedAt: now,
        leaseToken: "",
        leaseExpiresAt: null,
        coalescedInto: primaryJobId,
        result: {
          decision: "coalesced",
          primaryJobId: String(primaryJobId),
          primaryInboundMessageId: String(primaryMessageId),
        },
      },
    },
  );

  await Message.updateMany(
    { _id: { $in: related } },
    {
      $set: {
        "metadata.coalescedIntoMessage": primaryMessageId,
        "metadata.coalescedAt": now,
      },
    },
  );

  return result;
};

export default {
  loadCustomerTurn,
  completeCoalescedJobs,
};
