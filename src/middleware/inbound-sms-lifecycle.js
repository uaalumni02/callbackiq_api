import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import { evaluateDeterministicInboundGuardrails } from "../helpers/ai/aiGuardrails.js";
import ConversionEventService from "../services/conversionEvent.service.js";
import AutomationService from "../services/automation/automation.service.js";
import AutomationTriggerService from "../services/automation/automationTrigger.service.js";

/*
 * This middleware runs after Twilio signature validation and before the existing
 * inbound controller. It performs durable lifecycle work without changing the
 * proven SMS reply pipeline: a customer response immediately suppresses stale
 * follow-ups and records a deduplicated conversion event.
 */
const inboundSmsLifecycle = async (req, res, next) => {
  try {
    const businessPhone = String(req.body?.To || "").trim();
    const customerPhone = String(req.body?.From || "").trim();
    const providerMessageId = String(req.body?.MessageSid || req.body?.SmsSid || "").trim();

    if (!businessPhone || !customerPhone) return next();

    const business = await Business.findOne({ phone: businessPhone }).select("_id").lean();
    if (!business) return next();

    const conversation = await Conversation.findOne({
      business: business._id,
      customerPhone,
      status: { $ne: "archived" },
    })
      .sort({ lastMessageAt: -1 })
      .select("_id lead")
      .lean();

    if (!conversation) return next();

    await AutomationService.cancelObsolete({
      businessId: business._id,
      leadId: conversation.lead,
      conversationId: conversation._id,
      reason: "customer_replied",
    });
    await ConversionEventService.record({
      businessId: business._id,
      leadId: conversation.lead,
      conversationId: conversation._id,
      type: "customer_replied",
      channel: "sms",
      source: "twilio_webhook",
      idempotencyKey: providerMessageId ? `customer_replied:${providerMessageId}` : null,
      metadata: { providerMessageId: providerMessageId || null },
    });

    const customerMessage = String(req.body?.Body || "").trim();
    const deterministic = evaluateDeterministicInboundGuardrails({
      customerMessage,
      recentMessages: [],
    });
    const command = customerMessage.toUpperCase();
    const skipQualificationFollowUp =
      deterministic.handled ||
      ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "HELP", "INFO"].includes(command);

    if (!skipQualificationFollowUp) {
      const lifecycleContext = {
        businessId: business._id,
        conversationId: conversation._id,
        leadId: conversation.lead,
        providerMessageId,
      };
      res.once("finish", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        void (async () => {
          const [updatedBusiness, updatedConversation, updatedLead] = await Promise.all([
            Business.findById(lifecycleContext.businessId)
              .select("features.automatedFollowUpEnabled")
              .lean(),
            Conversation.findById(lifecycleContext.conversationId)
              .select("status humanTakeover bookingState.status")
              .lean(),
            lifecycleContext.leadId
              ? Lead.findById(lifecycleContext.leadId)
                  .select("serviceNeeded address preferredAppointmentTime status")
                  .lean()
              : null,
          ]);

          if (!updatedBusiness?.features?.automatedFollowUpEnabled) return;
          if (!updatedConversation || updatedConversation.status !== "open" || updatedConversation.humanTakeover) return;
          if (!updatedLead || ["booked", "lost", "spam"].includes(updatedLead.status)) return;
          if (["offering_slots", "awaiting_confirmation", "booking", "booked"].includes(updatedConversation.bookingState?.status)) return;

          const hasService =
            Boolean(String(updatedLead.serviceNeeded || "").trim()) &&
            String(updatedLead.serviceNeeded).trim().toLowerCase() !== "unknown";
          const hasAddress = Boolean(String(updatedLead.address || "").trim());
          const hasPreference = Boolean(
            String(updatedLead.preferredAppointmentTime || "").trim(),
          );
          if (hasService && hasAddress && hasPreference) return;

          await AutomationTriggerService.schedule({
            businessId: lifecycleContext.businessId,
            trigger: "incomplete_qualification",
            leadId: lifecycleContext.leadId,
            conversationId: lifecycleContext.conversationId,
            triggerInstanceId:
              lifecycleContext.providerMessageId ||
              `${lifecycleContext.conversationId}:${Date.now()}`,
            occurredAt: new Date(),
          });
        })().catch((error) => {
          console.error("Incomplete-qualification automation lifecycle failed:", error);
        });
      });
    }

    return next();
  } catch (error) {
    console.error("Inbound SMS lifecycle middleware failed:", error);
    return next();
  }
};

export default inboundSmsLifecycle;
