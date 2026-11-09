import { fixedResult } from './bookingFixedResult.policy.js';
import { selectOfferedSlot } from "./offeredSlotSelection.service.js";
import { classifySmsIntent } from "../messaging/smsIntentClassifier.service.js";
import AlertService from "../alert.service.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { filterAutomatedSlots } from '../scheduling/automatedSchedulingPolicy.service.js';
import { saveBookingTransition } from "./bookingTurnState.repository.js";
import { bookingInquiryOperations } from "./bookingInquiryRuntime.js";
const { formatSlot, handleReadOnlyAvailabilityInquiry } = bookingInquiryOperations;

export async function handleReadOnlyBookingTurn({ business, lead, conversation, text, bookingChannel }) {
  const smsIntent = classifySmsIntent({
    customerMessage: text,
    business,
    conversation,
  });

  const readOnlySlots = conversation?.bookingState?.offeredSlots || [];
  if (
    conversation?.bookingState?.status === "offering_slots" &&
    readOnlySlots.length
  ) {
    const expired = conversation.bookingState.expiresAt && new Date(conversation.bookingState.expiresAt) <= new Date();
    if (expired) {
      await saveBookingTransition(conversation, "inquiry_offer_expired");
      const refreshed = await handleReadOnlyAvailabilityInquiry({ business, lead, conversation, channel: bookingChannel, text: 'What is available?' });
      refreshed.result.reply = `The earlier options expired. ${refreshed.result.reply}`;
      return refreshed;
    }
    const selected = selectOfferedSlot(
      text,
      filterAutomatedSlots(readOnlySlots),
      business.timezone || "America/New_York",
    );

    if (!selected) {
      if (smsIntent.intents.availabilityInquiry || smsIntent.intents.scheduling) {
        return handleReadOnlyAvailabilityInquiry({
          channel: bookingChannel,
          business,
          lead,
          conversation,
          text,
        });
      }
      if (!/^\s*(?:option\s*)?\d+\s*[.!]?\s*$/i.test(text)) return { handled: false };
      return {
        handled: true,
        result: fixedResult({
          reply:
            "Please choose one of the available option numbers, or ask me to check another day.",
          category: "availability_inquiry",
        }),
      };
    }

    return recordReadOnlySelection({ business, lead, conversation, bookingChannel, selected });
  }

  if (smsIntent.intents.availabilityInquiry || (smsIntent.intents.scheduling && conversation?.bookingState?.searchStartDate)) {
    return handleReadOnlyAvailabilityInquiry({
          channel: bookingChannel,
      business,
      lead,
      conversation,
      text,
    });
  }

  return { handled: false };
}

async function recordReadOnlySelection({ business, lead, conversation, bookingChannel, selected }) {
  const selectedLabel = formatSlot(
    selected,
    business.timezone || "America/New_York",
  );
  if (lead) {
    assertVoiceTurnActive(); assertDistributedLeaseActive();
    lead.preferredAppointmentTime = selectedLabel;
    await lead.save();
  }

  assertVoiceTurnActive(); assertDistributedLeaseActive();
  const savedSelection = await AlertService.create({
    businessId: business._id, leadId: lead?._id, conversationId: conversation?._id,
    type: "system", actionRequired: true,
    recommendedAction: "Check the service address, service area and timing, then accept or decline the requested visit.",
    title: "Customer selected an appointment time",
    message:
      "Automatic booking is disabled, but the customer selected a real available slot. The team must confirm the appointment directly.",
    priority: ["high", "emergency"].includes(String(lead?.urgency || ""))
      ? "high"
      : "medium",
    metadata: {
      leadId: lead?._id ? String(lead._id) : "",
      conversationId: conversation?._id ? String(conversation._id) : "",
      selectedStartAt: selected.startAt,
      selectedEndAt: selected.endAt,
      channel: bookingChannel,
    },
    dedupeKey: `read_only_slot_selected:${business._id}:${conversation?._id || lead?._id || "unknown"}:${new Date(selected.startAt).toISOString()}`,
  });

  if (!savedSelection?.alert?._id) throw Object.assign(new Error("Selected time was not queued for review."), { code: "STAFF_ACTION_NOT_SAVED" });
  if (conversation?.set && typeof conversation.save === "function") {
    await saveBookingTransition(conversation, "inquiry_slot_referred", {
      selectedSlot: selected,
      escalatedAt: new Date(),
    });
  }

  return {
    handled: true,
    result: fixedResult({
      reply: `I’ve sent your request for ${selectedLabel} to ${business.businessName || "the business"}. That appointment is not confirmed until the team accepts it.${!lead?.address ? " I still need the service address to complete the request." : ""}`,
      category: "appointment_preference",
    }),
  };
}
