import { safeConsole } from "../helpers/logging/safeLogger.js";
import { durableWebhookWorkEnabled } from "../services/webhooks/webhookWork.service.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import AutomationTriggerService from "../services/automation/automationTrigger.service.js";

const MISSED_CALL_STATUSES = new Set([
  "busy",
  "failed",
  "no-answer",
  "no_answer",
  "canceled",
]);

export const scheduleMissedCallFollowUp = async ({ body, businessId, retryMissingConversation = false }) => {
  const businessPhone = String(body?.To || "").trim();
  const customerPhone = String(body?.From || "").trim();
  const providerCallId = String(body?.CallSid || body?.ParentCallSid || "").trim();

  if (!businessPhone || !customerPhone || !providerCallId) return;

  const business = await Business.findOne(businessId ? { _id: businessId } : { phone: businessPhone })
    .select("_id features.automatedFollowUpEnabled")
    .lean();
  if (!business?.features?.automatedFollowUpEnabled) return;

  const conversation = await Conversation.findOne({
    business: business._id,
    customerPhone,
    status: "open",
  })
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .select("_id lead")
    .lean();
  if (!conversation) {
    if (retryMissingConversation) throw Object.assign(new Error("Conversation not yet available"), { code: "FOLLOWUP_CONVERSATION_PENDING" });
    return;
  }

  await AutomationTriggerService.schedule({
    businessId: business._id,
    trigger: "missed_call_no_response",
    leadId: conversation.lead,
    conversationId: conversation._id,
    triggerInstanceId: providerCallId,
    occurredAt: new Date(),
  });
};

/*
 * The existing Twilio status controller remains the source of truth for call,
 * lead, conversation and SMS creation. This middleware waits for a successful
 * response, then schedules durable follow-up against the records the controller
 * just committed. Trigger idempotency prevents duplicate jobs on webhook retry.
 */
const missedCallAutomationLifecycle = (req, res, next) => {
  if (durableWebhookWorkEnabled()) return next();
  const callStatus = String(req.body?.CallStatus || "")
    .trim()
    .toLowerCase();

  if (!MISSED_CALL_STATUSES.has(callStatus)) return next();

  const body = { ...req.body };
  res.once("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    void scheduleMissedCallFollowUp({ body }).catch((error) => {
      safeConsole.error("Missed-call automation lifecycle failed:", error);
    });
  });

  return next();
};

export default missedCallAutomationLifecycle;
