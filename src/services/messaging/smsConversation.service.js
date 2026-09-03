// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: conversation-service
import Lead from "../../models/lead.js";
import Conversation from "../../models/conversation.js";
import SocketService from "../socket.service.js";
import { phoneLookupVariants } from "../../voice/voicePhone.service.js";
import { normalizeSmsPhone } from "./smsCompliance.service.js";

const isDuplicateKey = (error) => error?.code === 11000;

// CALLBACKIQ_SMS_TAKEOVER_LIFECYCLE
// A manual staff reply owns the conversation for a limited period. A later
// missed call may start a new automated recovery cycle only after that
// takeover has been inactive long enough to be considered stale.
const DEFAULT_HUMAN_TAKEOVER_TTL_MINUTES = 60;
const getHumanTakeoverTtlMs = () => {
  const configured = Number.parseInt(
    String(process.env.SMS_HUMAN_TAKEOVER_TTL_MINUTES || ""),
    10,
  );
  const minutes = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_HUMAN_TAKEOVER_TTL_MINUTES;
  return minutes * 60 * 1000;
};
const latestTakeoverActivityAt = (conversation) => {
  const candidates = [conversation?.humanTakeoverAt, conversation?.lastMessageAt]
    .map((value) => (value ? new Date(value).getTime() : Number.NaN))
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
};
const isStaleHumanTakeover = (conversation, now = new Date()) => {
  if (conversation?.humanTakeover !== true) return false;
  const latestActivityAt = latestTakeoverActivityAt(conversation);
  if (latestActivityAt == null) return false; // fail closed when history is incomplete
  return now.getTime() - latestActivityAt >= getHumanTakeoverTtlMs();
};

const findExistingLead = async ({ businessId, phone }) => {
  return Lead.findOne({
    business: businessId,
    $or: [
      { phoneLookup: phone },
      { phone: { $in: phoneLookupVariants(phone) } },
    ],
  }).sort({ updatedAt: -1 });
};

const upsertLead = async ({ business, customerPhone, body, source }) => {
  const businessId = business._id;
  let existing = await findExistingLead({ businessId, phone: customerPhone });
  let created = false;

  if (!existing) {
    try {
      existing = await Lead.findOneAndUpdate(
        { business: businessId, phoneLookup: customerPhone },
        {
          $setOnInsert: {
            business: businessId,
            customerName: source === "missed_call" ? "Missed Call Lead" : "New SMS Lead",
            phone: customerPhone,
            phoneLookup: customerPhone,
            serviceNeeded: "Unknown",
            urgency: "medium",
            source,
            status: source === "sms" ? "contacted" : "new",
            estimatedValue: business.estimatedJobValue || 0,
            notes: body || (source === "sms" ? "MMS attachment received." : ""),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      );
      created = true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      existing = await findExistingLead({ businessId, phone: customerPhone });
    }
  }

  if (!existing) throw new Error("Unable to create or resolve SMS lead");

  const updates = {};
  if (!existing.phoneLookup) updates.phoneLookup = customerPhone;
  if (existing.phone !== customerPhone) updates.phone = customerPhone;
  if (source === "sms" && existing.status === "new") updates.status = "contacted";
  if (body && (!existing.notes || existing.notes === "Unknown")) updates.notes = body;

  if (Object.keys(updates).length) {
    existing = await Lead.findByIdAndUpdate(existing._id, updates, {
      returnDocument: "after",
      runValidators: true,
    });
  }

  if (created) SocketService.emitLeadCreated(businessId, existing);
  else SocketService.emitLeadUpdated(businessId, existing);
  return existing;
};

const findActiveConversation = async ({ businessId, customerPhone }) => {
  return Conversation.findOne({
    business: businessId,
    status: { $ne: "archived" },
    $or: [
      { customerPhoneLookup: customerPhone },
      { customerPhone: { $in: phoneLookupVariants(customerPhone) } },
    ],
  }).sort({ lastMessageAt: -1 });
};

const upsertConversation = async ({
  business,
  lead,
  customerPhone,
  body,
  source,
  reopenEligible,
}) => {
  const businessId = business._id;
  let conversation = await findActiveConversation({ businessId, customerPhone });
  let created = false;

  if (!conversation) {
    try {
      conversation = await Conversation.findOneAndUpdate(
        {
          business: businessId,
          customerPhoneLookup: customerPhone,
          activeRecord: true,
        },
        {
          $setOnInsert: {
            business: businessId,
            lead: lead._id,
            customerPhone,
            customerPhoneLookup: customerPhone,
            customerName: lead.customerName,
            status: "open",
            activeRecord: true,
            aiEnabled: true,
            humanTakeover: false,
            lastMessage: body || "Attachment received",
            lastMessageAt: new Date(),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      );
      created = true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      conversation = await findActiveConversation({ businessId, customerPhone });
    }
  }

  if (!conversation) throw new Error("Unable to create or resolve SMS conversation");

  const updates = {
    lead: conversation.lead || lead._id,
    customerPhone,
    customerPhoneLookup: customerPhone,
    activeRecord: true,
  };

  if (body) {
    updates.lastMessage = body;
    updates.lastMessageAt = new Date();
  }

  const now = new Date();
  const staleTakeoverRecovery =
    reopenEligible &&
    source === "missed_call" &&
    isStaleHumanTakeover(conversation, now);
  const closedConversationRecovery =
    reopenEligible &&
    conversation.status === "closed" &&
    conversation.humanTakeover !== true;

  if (staleTakeoverRecovery || closedConversationRecovery) {
    updates.status = "open";
    updates.aiEnabled = true;
    updates.humanTakeover = false;
    updates.humanTakeoverAt = null;
    updates.humanTakeoverBy = null;
    updates.reopenedAt = now;
    updates.reopenReason = staleTakeoverRecovery
      ? "new_missed_call_after_stale_human_takeover"
      : "new_customer_contact";
    updates["bookingState.status"] = "not_started";
    updates["bookingState.escalatedAt"] = null;
    updates["orchestration.phase"] = "recovering";
    updates["orchestration.handoffStatus"] = "";
    updates["orchestration.handoffReason"] = "";
    updates["orchestration.handoffRequestedAt"] = null;
    updates["orchestration.handoffAcknowledgedAt"] = null;
    updates["orchestration.handoffInboundMessage"] = null;
    updates["orchestration.handoffOutboundMessage"] = null;
    updates["orchestration.handoffCallbackPhone"] = "";
    updates["orchestration.handoffLastError"] = "";
    updates["orchestration.handoffStatusReplyAt"] = null;
    updates["orchestration.silentFailureCount"] = 0;
    updates["orchestration.lastStateTransitionAt"] = now;
  }

  conversation = await Conversation.findByIdAndUpdate(conversation._id, updates, {
    returnDocument: "after",
    runValidators: true,
  });

  if (created) SocketService.emitConversationCreated(businessId, conversation);
  else SocketService.emitConversationUpdated(businessId, conversation);
  return conversation;
};

export const getOrCreateSmsLeadAndConversation = async ({
  business,
  customerPhone,
  body = "",
  source = "sms",
  reopenEligible = true,
}) => {
  if (!business?._id) throw new Error("business is required");
  const normalizedPhone = normalizeSmsPhone(customerPhone);
  if (!normalizedPhone) {
    const error = new Error("Inbound customer phone must be valid E.164");
    error.code = "INVALID_INBOUND_SMS_PHONE";
    throw error;
  }

  const lead = await upsertLead({
    business,
    customerPhone: normalizedPhone,
    body: String(body || "").trim(),
    source,
  });
  const conversation = await upsertConversation({
    business,
    lead,
    customerPhone: normalizedPhone,
    body: String(body || "").trim(),
    source,
    reopenEligible,
  });

  return { lead, conversation, customerPhone: normalizedPhone };
};

export default { getOrCreateSmsLeadAndConversation };
