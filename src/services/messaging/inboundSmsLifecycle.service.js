import { readFreshFollowUpSettings } from "../database/followUpSettingsRead.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import { evaluateDeterministicInboundGuardrails } from "../../helpers/ai/aiGuardrails.js";
import { classifyInboundSmsCommand } from "./contactPreference.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import AutomationService from "../automation/automation.service.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";

export const runInboundSmsLifecycleAfterClaim = async ({
  business,
  conversation,
  lead,
  inboundMessage,
  inboundSafety,
}) => {
  try {
    if (!business?._id || !conversation?._id || !inboundMessage?._id) return;

    const providerMessageId = String(
      inboundMessage.providerMessageId || "",
    ).trim();
    const customerMessage = String(inboundMessage.body || "").trim();
    const twilioOptOutType = String(
      inboundMessage?.metadata?.twilioOptOutType || "",
    ).trim();
    const command = classifyInboundSmsCommand(customerMessage, {
      twilioOptOutType,
    });

    await AutomationService.cancelObsolete({
      businessId: business._id,
      leadId: lead?._id || conversation.lead,
      conversationId: conversation._id,
      reason: "customer_replied",
      batch: true,
    });

    await ConversionEventService.record({
      businessId: business._id,
      leadId: lead?._id || conversation.lead,
      conversationId: conversation._id,
      type: "customer_replied",
      channel: "sms",
      source: "twilio_webhook",
      idempotencyKey: providerMessageId
        ? `customer_replied:${providerMessageId}`
        : `customer_replied:${inboundMessage._id}`,
      metadata: {
        providerMessageId: providerMessageId || null,
        inboundMessageId: String(inboundMessage._id),
      },
    });

    const deterministic = inboundSafety?.body === customerMessage &&
      Object.hasOwn(inboundSafety, "assessment")
      ? inboundSafety.assessment
      : customerMessage
      ? evaluateDeterministicInboundGuardrails({
          customerMessage,
          recentMessages: [],
        })
      : null;

    if (command.handled || deterministic?.handled) return;

    // Read each eligibility gate before fetching data used only by the next
    // gate. Keep fresh database checks: a request snapshot may predate takeover
    // or a settings change. Durable cancellation/event recording above always run.
    const updatedBusiness = await readFreshFollowUpSettings(business._id);
    if (!updatedBusiness?.features?.automatedFollowUpEnabled) return;

    const updatedConversation = await Conversation.findById(conversation._id)
      .select("status humanTakeover bookingState.status")
      .lean();
    if (!updatedConversation || updatedConversation.status !== "open" ||
        updatedConversation.humanTakeover) return;

    const updatedLead = lead?._id || conversation.lead
      ? await Lead.findById(lead?._id || conversation.lead)
          .select("serviceNeeded address preferredAppointmentTime status")
          .lean()
      : null;
    if (
      !updatedLead ||
      ["booked", "lost", "spam"].includes(updatedLead.status)
    ) {
      return;
    }
    if (
      [
        "offering_slots",
        "awaiting_confirmation",
        "booking",
        "booked",
      ].includes(updatedConversation.bookingState?.status)
    ) {
      return;
    }

    const hasService =
      Boolean(String(updatedLead.serviceNeeded || "").trim()) &&
      String(updatedLead.serviceNeeded).trim().toLowerCase() !== "unknown";
    const hasAddress = Boolean(String(updatedLead.address || "").trim());
    const hasPreference = Boolean(
      String(updatedLead.preferredAppointmentTime || "").trim(),
    );
    if (hasService && hasAddress && hasPreference) return;

    await AutomationTriggerService.schedule({
      businessId: business._id,
      trigger: "incomplete_qualification",
      leadId: lead?._id || conversation.lead,
      conversationId: conversation._id,
      triggerInstanceId:
        providerMessageId || String(inboundMessage._id),
      occurredAt: new Date(),
    });
  } catch (error) {
    // This lifecycle is enrichment. It must not be able to break durable ingress.
    logOperationalError("twilio.sms.lifecycle_after_claim_failed", error, {
      businessId: business?._id || null,
      conversationId: conversation?._id || null,
      inboundMessageId: inboundMessage?._id || null,
    });
  }
};

export default {
  runInboundSmsLifecycleAfterClaim,
};
