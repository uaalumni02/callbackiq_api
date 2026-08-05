import Lead from "../../models/lead.js";
import Conversation from "../../models/conversation.js";
import SocketService from "../socket.service.js";
import { phoneLookupVariants } from "../../voice/voicePhone.service.js";
import { normalizeSmsPhone } from "./smsCompliance.service.js";

const isDuplicateKey = (error) => error?.code === 11000;

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

  if (
    reopenEligible &&
    conversation.status === "closed" &&
    conversation.humanTakeover !== true
  ) {
    updates.status = "open";
    updates.aiEnabled = true;
    updates.humanTakeover = false;
    updates.reopenedAt = new Date();
    updates.reopenReason = "new_customer_contact";
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
    reopenEligible,
  });

  return { lead, conversation, customerPhone: normalizedPhone };
};

export default { getOrCreateSmsLeadAndConversation };
