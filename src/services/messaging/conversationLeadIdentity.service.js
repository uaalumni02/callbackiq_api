import { readOnlySnapshot } from "../database/readOnlySnapshot.js";
import Lead from "../../models/lead.js";
import Conversation from "../../models/conversation.js";
import SocketService from "../socket.service.js";
import { normalizeSmsPhone } from "./smsCompliance.service.js";

// Shared by inbound SMS and voice session initialization.
export const reconcileConversationLead = async ({ business, lead, conversation, customerPhone, readOnly = false }) => {
  // A phone can have historical leads. Prefer the conversation's live lead;
  // never return an independently selected lead paired with another request.
  if (String(conversation.lead) !== String(lead._id)) {
    const linked = conversation.lead ? await readOnlySnapshot(Lead, Lead.findOne({ _id: conversation.lead }), readOnly) : null;
    if (linked) {
      if (String(linked.business) !== String(business._id) ||
          normalizeSmsPhone(linked.phone) !== customerPhone) {
        throw Object.assign(new Error("Conversation lead identity requires staff review"), { code: "SMS_LEAD_IDENTITY_CONFLICT" });
      }
      lead = linked;
    } else {
      if (String(lead.business) !== String(business._id) || normalizeSmsPhone(lead.phone) !== customerPhone) {
        throw Object.assign(new Error("Replacement lead identity requires staff review"), { code: "SMS_LEAD_IDENTITY_CONFLICT" });
      }
      if (conversation.bookingState?.appointment) {
        throw Object.assign(new Error("Orphaned appointment conversation requires staff review"), { code: "SMS_ORPHANED_APPOINTMENT" });
      }
      // Compare-and-set: a concurrent relink must be retried, not overwritten.
      const repaired = await readOnlySnapshot(Conversation, Conversation.findOneAndUpdate({
        _id: conversation._id, business: business._id,
        lead: conversation.lead || null, customerPhone: customerPhone,
      }, { $set: { lead: lead._id, bookingState: { status: "not_started" },
        "conversationMemory.recoveryIntake": {} }, $unset: { serviceEligibility: 1 } },
      { returnDocument: "after", runValidators: true }), readOnly);
      if (!repaired) throw Object.assign(new Error("Conversation identity changed during repair"), { code: "SMS_LEAD_REPAIR_CONFLICT" });
      conversation = repaired;
      SocketService.emitConversationUpdated(business._id, conversation);
    }
  }
  return { lead, conversation };
};
