import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import AlertService from "../services/alert.service.js";
import { sendSms } from "../services/twilioSmsService.js";
import { withDistributedLease } from "../services/distributedLease.service.js";
import { logOperationalError, logOperationalEvent } from "../helpers/logging/safeLogger.js";
import { deriveSmsConversationPhase } from "../services/messaging/smsConversationState.service.js";

let timer = null;
let running = false;

const positive = (value, fallback, min = 1000, max = 86400000) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const intervalMs = () =>
  positive(process.env.SMS_LIFECYCLE_INTERVAL_MS, 60000, 15000, 15 * 60000);
const humanTakeoverTtlMs = () =>
  positive(Number(process.env.SMS_HUMAN_TAKEOVER_TTL_MINUTES || 60) * 60000, 60 * 60000, 5 * 60000, 24 * 60 * 60000);
const recoveryNudgeDelayMs = () =>
  positive(process.env.SMS_RECOVERY_NUDGE_DELAY_MS, 30 * 60000, 5 * 60000, 6 * 60 * 60000);

const saveLifecycleOutbound = async ({ conversation, body, sent, event }) => {
  if (sent?.suppressed || !sent?.sid) return null;
  try {
    return await Message.findOneAndUpdate(
      { business: conversation.business, providerMessageId: sent.sid },
      {
        $setOnInsert: {
          business: conversation.business,
          conversation: conversation._id,
          lead: conversation.lead || null,
          direction: "outbound",
          from: sent.from || conversation.replyFromPhone,
          to: conversation.customerPhone,
          body: sent.body || body,
          provider: "twilio",
          providerMessageId: sent.sid,
          status: sent.status || "sent",
          deliveryStatus: sent.status || "sent",
          generatedBy: "automation",
          actorType: "automation",
          usageCategory: "conversation_lifecycle",
          metadata: { source: "conversation_lifecycle", event },
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (Number(error?.code) === 11000) return null;
    throw error;
  }
};

const sendLifecycleSms = async ({ conversation, body, event, idempotencySuffix }) => {
  const sent = await sendSms({
    businessId: conversation.business,
    from: conversation.replyFromPhone,
    to: conversation.customerPhone,
    body,
    actorType: "automation",
    source: "conversation_lifecycle",
    usageCategory: "conversation_lifecycle",
    conversationId: conversation._id,
    leadId: conversation.lead || null,
    directResponse: false,
    metadata: {
      event,
      idempotencyKey: `sms-lifecycle:${conversation._id}:${event}:${idempotencySuffix}`,
    },
  });
  await saveLifecycleOutbound({ conversation, body, sent, event });
  return sent;
};

const releaseStaleHumanTakeover = async (conversation, now) => {
  if (conversation.humanTakeover !== true) return false;
  const activityAt = new Date(conversation.lastMessageAt || conversation.humanTakeoverAt || 0);
  if (!Number.isFinite(activityAt.getTime())) return false;
  if (now.getTime() - activityAt.getTime() < humanTakeoverTtlMs()) return false;

  const updated = await Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      humanTakeover: true,
      status: "open",
      lastMessageAt: conversation.lastMessageAt,
    },
    {
      $set: {
        humanTakeover: false,
        humanTakeoverAt: null,
        humanTakeoverBy: null,
        aiEnabled: true,
        "orchestration.phase": deriveSmsConversationPhase({
          ...(conversation.toObject?.() || conversation),
          humanTakeover: false,
        }),
        "orchestration.lastStateTransitionAt": now,
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) return false;

  await AlertService.createSystemAlert({
    businessId: conversation.business,
    title: "SMS human takeover expired",
    message: "Automated SMS assistance is eligible to resume because the human takeover window expired.",
    priority: "low",
    metadata: { conversationId: String(conversation._id) },
    dedupeKey: `sms_human_takeover_expired:${conversation._id}:${activityAt.toISOString()}`,
  });
  return true;
};

const expireBookingOffer = async (conversation, now) => {
  const status = String(conversation.bookingState?.status || "");
  if (!["offering_slots", "awaiting_confirmation"].includes(status)) return false;
  const expiresAt = conversation.bookingState?.expiresAt && new Date(conversation.bookingState.expiresAt);
  if (!expiresAt || expiresAt > now) return false;

  const claimed = await Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      "bookingState.status": status,
      "bookingState.expiresAt": { $lte: now },
    },
    {
      $set: {
        "bookingState.status": "collecting_preference",
        "bookingState.selectedSlot": null,
        "bookingState.offeredSlots": [],
        "bookingState.expiresAt": null,
        "bookingState.lastError": "offer_expired",
        "orchestration.phase": "scheduling",
        "orchestration.lastStateTransitionAt": now,
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return false;

  await sendLifecycleSms({
    conversation: claimed,
    body: "That time is no longer held. Send another day that works and I’ll find the closest opening.",
    event: "booking_offer_expired",
    idempotencySuffix: expiresAt.toISOString(),
  });
  return true;
};

const nudgeAbandonedRecovery = async (conversation, now) => {
  if (conversation.status !== "open" || conversation.aiEnabled === false || conversation.humanTakeover) return false;

  const lastInbound = await Message.findOne({
    conversation: conversation._id,
    direction: "inbound",
  }).sort({ createdAt: -1, _id: -1 }).select("createdAt").lean();

  const lastRecovery = await Message.findOne({
    conversation: conversation._id,
    direction: "outbound",
    "metadata.source": "missed_call_recovery",
  }).sort({ createdAt: -1, _id: -1 }).select("createdAt").lean();

  if (!lastRecovery?.createdAt) return false;
  if (lastInbound?.createdAt && new Date(lastInbound.createdAt) > new Date(lastRecovery.createdAt)) return false;

  const nudgeCount = Number(conversation.lifecycle?.recoveryNudgeCount || 0);
  if (nudgeCount >= 2) return false;

  const dueAt = conversation.lifecycle?.nextRecoveryNudgeAt
    ? new Date(conversation.lifecycle.nextRecoveryNudgeAt)
    : new Date(new Date(lastRecovery.createdAt).getTime() + recoveryNudgeDelayMs());
  if (dueAt > now) return false;

  const nextCount = nudgeCount + 1;
  const claimed = await Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      $or: [
        { "lifecycle.recoveryNudgeCount": nudgeCount },
        ...(nudgeCount === 0 ? [{ "lifecycle.recoveryNudgeCount": { $exists: false } }] : []),
      ],
    },
    {
      $set: {
        "lifecycle.recoveryNudgeCount": nextCount,
        "lifecycle.lastLifecycleActionAt": now,
        "lifecycle.nextRecoveryNudgeAt": nextCount >= 2 ? null : new Date(now.getTime() + 18 * 60 * 60000),
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return false;

  const body = nextCount === 1
    ? "Just checking in — still need a hand? Text a quick note about the issue and we’ll help with the next step."
    : "Good morning — if you still need help from that missed call, reply here and we’ll pick it back up.";

  const sent = await sendLifecycleSms({
    conversation: claimed,
    body,
    event: `recovery_nudge_${nextCount}`,
    idempotencySuffix: new Date(lastRecovery.createdAt).toISOString(),
  });

  if (sent?.policyBlocked) {
    await Conversation.updateOne(
      { _id: conversation._id, "lifecycle.recoveryNudgeCount": nextCount },
      {
        $set: {
          "lifecycle.recoveryNudgeCount": nudgeCount,
          "lifecycle.nextRecoveryNudgeAt": new Date(now.getTime() + 60 * 60000),
        },
      },
    );
    return false;
  }
  return true;
};

const processConversation = async (conversation, now) => {
  const lease = await withDistributedLease(
    `sms-conversation:${conversation._id}`,
    async () => {
      if (await releaseStaleHumanTakeover(conversation, now)) return "takeover_released";
      if (await expireBookingOffer(conversation, now)) return "offer_expired";
      if (await nudgeAbandonedRecovery(conversation, now)) return "recovery_nudged";
      return "noop";
    },
    { ttlMs: 30000, metadata: { worker: "conversation_lifecycle" } },
  );
  return lease.acquired ? lease.value : "lease_busy";
};

export const runConversationLifecycleOnce = async ({ now = new Date(), limit = 100 } = {}) => {
  if (running) return { skipped: true, processed: 0 };
  running = true;
  try {
    const conversations = await Conversation.find({
      status: "open",
      $or: [
        { humanTakeover: true },
        { "bookingState.expiresAt": { $lte: now } },
        { "lifecycle.recoveryNudgeCount": { $lt: 2 } },
        { "lifecycle.recoveryNudgeCount": { $exists: false } },
      ],
    })
      .sort({ lastMessageAt: 1, _id: 1 })
      .limit(Math.max(1, Math.min(500, Number(limit) || 100)));

    let processed = 0;
    const outcomes = {};
    for (const conversation of conversations) {
      const outcome = await processConversation(conversation, now);
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
      if (!["noop", "lease_busy"].includes(outcome)) processed += 1;
    }
    return { skipped: false, processed, scanned: conversations.length, outcomes };
  } finally {
    running = false;
  }
};

export const startConversationLifecycleWorker = () => {
  if (timer || String(process.env.SMS_LIFECYCLE_WORKER_ENABLED || "true").toLowerCase() === "false") return timer;
  void runConversationLifecycleOnce().catch((error) =>
    logOperationalError("sms.lifecycle.initial_failed", error),
  );
  timer = setInterval(() => {
    void runConversationLifecycleOnce()
      .then((result) => {
        if (result.processed) logOperationalEvent("sms.lifecycle.batch", result);
      })
      .catch((error) => logOperationalError("sms.lifecycle.failed", error));
  }, intervalMs());
  timer.unref?.();
  return timer;
};

export const stopConversationLifecycleWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
};

export default {
  runConversationLifecycleOnce,
  startConversationLifecycleWorker,
  stopConversationLifecycleWorker,
};
