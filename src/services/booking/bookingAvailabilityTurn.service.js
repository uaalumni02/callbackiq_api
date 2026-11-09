import { fixedResult } from './bookingFixedResult.policy.js';
import { spreadSlotOptions, selectSlotOptions, selectOfferedSlot } from "./offeredSlotSelection.service.js";
import { renderAppointmentResponse } from '../scheduling/customerAppointmentPresentation.service.js';
import { requestStaffSchedulingReview } from "./staffSchedulingReview.service.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import { formatDateKey } from "../scheduling/timezone.service.js";
import { filterAutomatedSlots } from '../scheduling/automatedSchedulingPolicy.service.js';
import escalateToHumanTool from "../../helpers/ai/tools/escalateToHuman.tool.js";
import getAvailabilityTool from "../../helpers/ai/tools/getAvailability.tool.js";
import {
  filterSlotsByTimePreference,
  findDateRange,
  hasAppointmentPreferenceHint,
  parseTimePreference,
  rankSlotsByTimePreference,
} from "./appointmentPreferenceParser.service.js";
import { applyBookingEvent, saveBookingTransition } from "./bookingTurnState.repository.js";
import { bookingInquiryOperations } from "./bookingInquiryRuntime.js";
const { formatSlot, buildAvailabilityPricingNote, handleAvailabilityProviderFailure } = bookingInquiryOperations;

export async function collectBookingPreference(context) {
  const { business, lead, conversation, activeConversation, text, smsIntent, bookingChannel } = context;
  const timeZone = business.timezone || "America/New_York";
  const availabilityInquiry = Boolean(
    smsIntent.intents.availabilityInquiry ||
      activeConversation.bookingState?.availabilityInquiry,
  );
  const requestedRange = findDateRange(text, timeZone);
  const today = formatDateKey(new Date(), timeZone);
  const previousRange = activeConversation.bookingState.searchStartDate && activeConversation.bookingState.searchEndDate
    ? { startDate: activeConversation.bookingState.searchStartDate, endDate: activeConversation.bookingState.searchEndDate }
    : findDateRange(lead?.preferredAppointmentTime || '', timeZone);
  const range =
    requestedRange || previousRange ||
    (availabilityInquiry
      ? {
          startDate: today,
          endDate: formatDateKey(
            new Date(Date.now() + 6 * 86_400_000),
            timeZone,
          ),
        }
      : null);
  const timePreference = parseTimePreference(text, timeZone);
  const timeOfDay = timePreference.timeOfDay;

  if (!range) {
    return {
      handled: true,
      result: fixedResult({
        reply:
          "Please send the day and time that work for you. You can say things like tomorrow at 2, day after next around 3ish, Friday morning, Aug 10, or after 5.",
      }),
    };
  }

  await saveBookingTransition(activeConversation, "search_range_selected", { searchStartDate: range.startDate, searchEndDate: range.endDate });

  let availability;
  try {
    availability = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id,
      serviceOfferingId:
        activeConversation.bookingState.serviceOffering,
      startDate: range.startDate,
      endDate: range.endDate,
      postalCode: activeConversation.bookingState.postalCode,
    });
  } catch (error) {
    return handleAvailabilityProviderFailure({
      business,
      lead,
      conversation: activeConversation,
      error,
      customerMessage: text,
      code: "primary_availability_provider_failed",
    });
  }
  const matchingSlots = filterSlotsByTimePreference(
    filterAutomatedSlots(availability.slots),
    timePreference,
    timeZone,
  );
  const offeredSlots = selectSlotOptions(
    matchingSlots,
    lead?.urgency,
    3,
  );

  if (offeredSlots.length === 0 && range.startDate === today && range.endDate === today) {
    return { handled: true, result: await requestStaffSchedulingReview({ business, lead, conversation: activeConversation, customerMessage: text, channel: bookingChannel }) };
  }
  if (offeredSlots.length === 0) {
    return offerExpandedAvailability(context, { range, timeZone, timePreference, timeOfDay });
  }
  return recordBookingOffers(context, { offeredSlots, timeZone, timeOfDay, availabilityInquiry });
}

function toBookingOffer(slot, timezone) {
  return {
    startAt: new Date(slot.startAt),
    endAt: new Date(slot.endAt),
    timezone,
    label: formatSlot(slot, timezone),
    arrivalStartAt: slot.arrivalStartAt,
    arrivalEndAt: slot.arrivalEndAt,
    requiresBusinessApproval: slot.requiresBusinessApproval !== false,
    selectionSubmits: true,
  };
}

async function recordBookingOffers({ business, lead, activeConversation, text, bookingChannel, bookingSource, bookingEventPrefix },
  { offeredSlots, timeZone, timeOfDay, availabilityInquiry }) {
  await saveBookingTransition(activeConversation, "slots_offered", {
    timeOfDay,
    preferredStart: new Date(offeredSlots[0].startAt),
    preferredEnd: new Date(
      offeredSlots[offeredSlots.length - 1].endAt,
    ),
    offeredSlots: offeredSlots.map((slot) => toBookingOffer(slot, timeZone)),
    lastCustomerPreference: availabilityInquiry
      ? activeConversation.bookingState?.lastCustomerPreference || ""
      : text,
    lastAvailabilityCheckedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });

  await ConversionEventService.record({
    businessId: business._id,
    leadId: lead?._id,
    conversationId: activeConversation._id,
    type: "appointment_offered",
    channel: bookingChannel,
    source: bookingSource,
    idempotencyKey: `${bookingEventPrefix}appointment_offered:${activeConversation._id}:${offeredSlots[0].startAt}`,
    metadata: { offeredSlots },
  });

  await AutomationTriggerService.schedule({
    businessId: business._id,
    trigger: "appointment_offered_not_selected",
    leadId: lead?._id,
    conversationId: activeConversation._id,
    triggerInstanceId: `${activeConversation._id}:${offeredSlots[0].startAt}`,
  });

  const options = offeredSlots
    .map(
      (slot, index) =>
        `${index + 1}) ${formatSlot(slot, timeZone)}`,
    )
    .join("; ");
  const compoundPricingNote = await buildAvailabilityPricingNote({
    business,
    bookingState: activeConversation.bookingState,
    lead,
    text,
  });

  return {
    handled: true,
    result: fixedResult({
      reply: `${compoundPricingNote ? `${compoundPricingNote} ` : ""}${renderAppointmentResponse({ kind: 'offer', options: `I have ${options}`, requiresApproval: offeredSlots.some(slot => slot.requiresBusinessApproval !== false) }, bookingChannel)}`,
    }),
  };
}

async function offerExpandedAvailability({ business, lead, conversation, activeConversation, text, bookingChannel },
  { range, timeZone, timePreference, timeOfDay }) {
  const attempts = Number(activeConversation.bookingState?.negotiationAttempts || 0) + 1;
  const expandedRange = {
    startDate: range.startDate,
    endDate: formatDateKey(new Date(Date.now() + 14 * 86_400_000), timeZone),
  };
  let alternatives = [];
  try {
    const expanded = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id,
      serviceOfferingId: activeConversation.bookingState.serviceOffering,
      startDate: expandedRange.startDate,
      endDate: expandedRange.endDate,
      postalCode: activeConversation.bookingState.postalCode,
    });
    const expandedSlots = filterAutomatedSlots(expanded.slots);
    const expandedMatches = filterSlotsByTimePreference(
      expandedSlots,
      timePreference,
      timeZone,
    );
    alternatives = expandedMatches.length
      ? selectSlotOptions(expandedMatches, lead?.urgency, 3)
      : ["high", "emergency"].includes(
            String(lead?.urgency || "").toLowerCase(),
          )
        ? selectSlotOptions(expandedSlots, lead?.urgency, 3)
        : timePreference.targetMinutes !== null
          ? rankSlotsByTimePreference(
              expandedSlots,
              timePreference,
              timeZone,
            ).slice(0, 3)
          : spreadSlotOptions(expandedSlots, 3);
  } catch (error) {
    return handleAvailabilityProviderFailure({
      business,
      lead,
      conversation: activeConversation,
      error,
      customerMessage: text,
      code: "expanded_availability_provider_failed",
    });
  }

  await saveBookingTransition(activeConversation, "availability_checked", {
    negotiationAttempts: attempts,
    lastCustomerPreference: text,
    lastAvailabilityCheckedAt: new Date(),
  });

  if (attempts >= 3 && alternatives.length === 0) {
    await escalateToHumanTool({
      businessId: business._id,
      leadId: lead?._id,
      conversationId: activeConversation._id,
      reason: "scheduling_no_match_after_three_attempts",
      customerMessage: text,
    });
    await saveBookingTransition(activeConversation, "scheduling_escalated", {
      escalatedAt: new Date(),
    });
    return {
      handled: true,
      result: fixedResult({
        reply: "I’m not finding a good calendar match yet, so I’ve sent your availability to the team. They’ll follow up to find the best time.",
        category: "human_requested",
      }),
    };
  }

  if (alternatives.length) {
    const options = alternatives
      .map((slot, index) => `${index + 1}) ${formatSlot(slot, timeZone)}`)
      .join("; ");
    await saveBookingTransition(activeConversation, "alternative_slots_offered", {
      offeredSlots: alternatives.map((slot) => toBookingOffer(slot, timeZone)),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    return { handled: true, result: fixedResult({
      reply: `That time isn’t available. ${renderAppointmentResponse({ kind: 'offer', options: `I have ${options}`, requiresApproval: alternatives.some(slot => slot.requiresBusinessApproval !== false) }, bookingChannel)}`,
    }) };
  }

  return {
    handled: true,
    result: fixedResult({
      reply: timeOfDay
        ? `I don’t see an available ${timeOfDay} time in that window. What other day or time works for you?`
        : "I don’t see an available time in that window. What other day or time works for you?",
    }),
  };
}

export async function selectBookingOffer({ business, lead, activeConversation, text, smsIntent, bookingChannel, bookingSource, handle, handleTurn }) {
  const slot = selectOfferedSlot(
    text,
    filterAutomatedSlots(activeConversation.bookingState.offeredSlots || []),
    business.timezone || "America/New_York",
  );

  if (!slot) {
    if (smsIntent.intents.availabilityInquiry || hasAppointmentPreferenceHint(text, business.timezone || "America/New_York")) {
      await applyBookingEvent(activeConversation, "request_new_offer", { businessId: business._id });
      return handle({
        business,
        lead,
        conversation: activeConversation,
        customerMessage: text,
        channel: bookingChannel,
        source: bookingSource,
      });
    }

    return {
      handled: true,
      result: fixedResult({
        reply:
          "Please reply with the option number, or send another day.",
      }),
    };
  }

  await applyBookingEvent(activeConversation, "select_offer", {
    businessId: business._id,
    selectedSlot: slot,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });

  if (bookingChannel === 'sms' && slot.selectionSubmits === true &&
      activeConversation.bookingState.streetAddress && activeConversation.bookingState.postalCode &&
      activeConversation.bookingState.lastError !== 'reschedule_requested' &&
      /^(?:option\s*)?[12]\s*[.!]?$/i.test(text)) {
    return handleTurn({ business, lead, conversation: activeConversation, customerMessage: 'YES', channel: bookingChannel, source: bookingSource });
  }
  const serviceName = lead?.serviceNeeded || "the requested service";
  const address = [
    activeConversation.bookingState.streetAddress || lead?.address,
    activeConversation.bookingState.postalCode,
  ]
    .filter(Boolean)
    .join(", ") || `ZIP ${activeConversation.bookingState.postalCode}`;

  return {
    handled: true,
    result: fixedResult({
      reply: renderAppointmentResponse({ kind: 'review', label: formatSlot(slot, business.timezone || 'America/New_York'), service: serviceName, address, requiresApproval: slot.requiresBusinessApproval !== false }, bookingChannel),
    }),
  };
}
