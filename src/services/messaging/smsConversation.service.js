import { readOnlySnapshot } from "../database/readOnlySnapshot.js";
import { linkRecentTrackedCalls } from "./trackedCallLink.service.js";
import { reconcileConversationLead } from "./conversationLeadIdentity.service.js";
// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: conversation-service
import Lead from "../../models/lead.js";
import { updateSmsConversationSnapshot } from './smsConversationUpdateBatch.service.js';
import { createFreshFindOneBatch } from '../database/freshFindOneBatch.js';
import Conversation from "../../models/conversation.js";
import SocketService from "../socket.service.js";
import { phoneLookupVariants } from "../../voice/voicePhone.service.js";
import { normalizeSmsPhone } from "./smsCompliance.service.js";

const freshLead = createFreshFindOneBatch(Lead, { sort: { updatedAt: -1 }, defaults: true });
const freshConversation = createFreshFindOneBatch(Conversation, { sort: { lastMessageAt: -1 }, defaults: true });

const isDuplicateKey = (error) => error?.code === 11000;

// A new phone call is not a new service request. Keep intake, appointment,
// handoff, and staff ownership intact until an explicit workflow changes them.
const findExistingLead = async ({ businessId, phone, readOnly }) => {
  if (readOnly && Lead.schema && typeof Lead.aggregate === 'function') return freshLead({
    business: businessId, $or: [{ phoneLookup: phone }, { phone: { $in: phoneLookupVariants(phone) } }],
  });
  return readOnlySnapshot(Lead, Lead.findOne({
    business: businessId,
    $or: [
      { phoneLookup: phone },
      { phone: { $in: phoneLookupVariants(phone) } },
    ],
  }).sort({ updatedAt: -1 }), readOnly);
};

const upsertLead = async ({ business, customerPhone, body, source, readOnly }) => {
  const businessId = business._id;
  let existing = await findExistingLead({ businessId, phone: customerPhone, readOnly });
  let created = false;

  if (!existing) {
    try {
      existing = await readOnlySnapshot(Lead, Lead.findOneAndUpdate(
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
            estimatedValue: null,
            valuation: { source: "unknown", basis: "Not estimated" },
            valuationVersion: 0,
            notes: body || (source === "sms" ? "MMS attachment received." : ""),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      ), readOnly);
      created = true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      existing = await findExistingLead({ businessId, phone: customerPhone, readOnly });
    }
  }

  if (!existing) throw new Error("Unable to create or resolve SMS lead");

  const updates = {};
  if (!existing.phoneLookup) updates.phoneLookup = customerPhone;
  if (existing.phone !== customerPhone) updates.phone = customerPhone;
  if (source === "sms" && existing.status === "new") updates.status = "contacted";
  if (body && (!existing.notes || existing.notes === "Unknown")) updates.notes = body;

  if (Object.keys(updates).length) {
    existing = await readOnlySnapshot(Lead, Lead.findByIdAndUpdate(existing._id, updates, {
      returnDocument: "after",
      runValidators: true,
    }), readOnly);
  }

  if (created) SocketService.emitLeadCreated(businessId, existing);
  else SocketService.emitLeadUpdated(businessId, existing);
  return existing;
};

const findActiveConversation = async ({ businessId, customerPhone, readOnly }) => {
  if (readOnly && Conversation.schema && typeof Conversation.aggregate === 'function') return freshConversation({
    business: businessId, status: { $ne: 'archived' },
    $or: [{ customerPhoneLookup: customerPhone }, { customerPhone: { $in: phoneLookupVariants(customerPhone) } }],
  });
  return readOnlySnapshot(Conversation, Conversation.findOne({
    business: businessId,
    status: { $ne: "archived" },
    $or: [
      { customerPhoneLookup: customerPhone },
      { customerPhone: { $in: phoneLookupVariants(customerPhone) } },
    ],
  }).sort({ lastMessageAt: -1 }), readOnly);
};

const upsertConversation = async ({
  business,
  lead,
  customerPhone,
  body,
  source,
  reopenEligible,
  recoveryJourneyKey,
  readOnly,
}) => {
  const businessId = business._id;
  let conversation = await findActiveConversation({ businessId, customerPhone, readOnly });
  let created = false;

  if (!conversation) {
    try {
      conversation = await readOnlySnapshot(Conversation, Conversation.findOneAndUpdate(
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
            "orchestration.recoveryJourneyKey": String(recoveryJourneyKey || "").trim(),
            "orchestration.recoveryJourneyStartedAt": new Date(),
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
      ), readOnly);
      created = true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      conversation = await findActiveConversation({ businessId, customerPhone, readOnly });
    }
  }

  if (!conversation) throw new Error("Unable to create or resolve SMS conversation");

  const updates = {
    lead: conversation.lead || lead._id,
    customerPhone,
    customerPhoneLookup: customerPhone,
  };

  if (body) {
    updates.lastMessage = body;
    updates.lastMessageAt = new Date();
  }

  conversation = readOnly ? await updateSmsConversationSnapshot({ businessId, conversationId: conversation._id, update: updates }) : await readOnlySnapshot(Conversation, Conversation.findByIdAndUpdate(conversation._id, updates, {
    returnDocument: "after",
    runValidators: true,
  }), readOnly);

  if (reopenEligible && conversation.status === "closed" &&
      conversation.humanTakeover !== true && conversation.aiEnabled !== false) {
    conversation = await readOnlySnapshot(Conversation, Conversation.findOneAndUpdate({
      _id: conversation._id, business: businessId, status: "closed",
      humanTakeover: { $ne: true }, aiEnabled: { $ne: false },
    }, { $set: { status: "open", reopenedAt: new Date(), reopenReason: "returning_customer_contact" } },
    { returnDocument: "after", runValidators: true }), readOnly) || conversation;
  }

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
  recoveryJourneyKey = "",
  readOnly = false,
}) => {
  if (!business?._id) throw new Error("business is required");
  const normalizedPhone = normalizeSmsPhone(customerPhone);
  if (!normalizedPhone) {
    const error = new Error("Inbound customer phone must be valid E.164");
    error.code = "INVALID_INBOUND_SMS_PHONE";
    throw error;
  }

  let lead = await upsertLead({
    business,
    customerPhone: normalizedPhone,
    body: String(body || "").trim(),
    source,
    readOnly,
  });
  let conversation = await upsertConversation({
    business,
    lead,
    customerPhone: normalizedPhone,
    body: String(body || "").trim(),
    source,
    reopenEligible,
    recoveryJourneyKey,
    readOnly,
  });

  ({ lead, conversation } = await reconcileConversationLead({ business, lead, conversation, customerPhone: normalizedPhone, readOnly }));
  await linkRecentTrackedCalls({ businessId: business._id, leadId: lead._id, conversationId: conversation._id, phone: normalizedPhone, batch: readOnly });
  return { lead, conversation, customerPhone: normalizedPhone };
};

export default { getOrCreateSmsLeadAndConversation };
