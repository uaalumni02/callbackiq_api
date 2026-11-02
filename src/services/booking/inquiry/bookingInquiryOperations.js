/* Source-exact legacy booking inquiry/advisory functions. Decision order unchanged. */
export function createBookingInquiryOperations(deps) {
  const { AlertService, assertDistributedLeaseActive, assertVoiceTurnActive, automatedSchedulingNotice, classifySmsIntent, customerAppointmentLabel, extractCustomerAddress, extractCustomerPostalCode, filterAutomatedSlots, filterSlotsByTimePreference, findDateRange, fixedResult, formatDateKey, getApprovedServiceEstimate, getAvailabilityTool, hasAppointmentPreferenceHint, logOperationalError, logOperationalEvent, parseTimePreference, rankSlotsByTimePreference, requestStaffSchedulingReview, searchServicesTool, selectSlotOptions, updateState, withoutCustomerPostalCode } = deps;
const cleanStreetAddress = (value) =>
  withoutCustomerPostalCode(value)
    .trim()
    .replace(/^(?:yes|yeah|yep|sure|okay|ok)[,\s-]*/i, "")
    .replace(/^(?:it(?:'s| is)|the address is|address is|we(?:'re| are) at|i(?:'m| am) at|at)\s+/i, "")
    .replace(/^[,;:\s-]+|[,;:\s-]+$/g, "")
    .replace(/\s{2,}/g, " ");

const parseStreetAddress = value => {
  const address = extractCustomerAddress(String(value || '').replace(/^(?:yes|yeah|yep|sure|okay|ok)[,\s-]*/i, ''), { expected: true });
  return { street: cleanStreetAddress(address), valid: Boolean(address) };
};

const buildAvailabilityPricingNote = async ({
  business,
  bookingState = null,
  lead,
  text,
}) => {
  const intent = classifySmsIntent({
    customerMessage: text,
    business,
  });

  if (!intent.intents.pricing) return "";

  try {
    const approved = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead?.serviceNeeded, customerMessage: text });
    if (approved) return approved;
  } catch {
    // Pricing context must never prevent a real availability lookup.
  }

  return "I don’t have a business-approved price range for that service, so I don’t want to guess. Final pricing depends on the actual scope and technician evaluation.";
};

const formatSlot = customerAppointmentLabel;

const handleReadOnlyAvailabilityInquiry = async ({
  business,
  lead,
  conversation,
  text,
  channel = "sms",
}) => {
  const businessName = String(
    business?.businessName || "the business",
  ).trim();
  const businessId = business?._id || business?.id;
  const timeZone = business?.timezone || "America/New_York";
  const currentService = classifySmsIntent({ customerMessage: text, business }).entities.serviceNeeded;
  const storedService = String(lead?.serviceNeeded || "").trim();
  const knownService = storedService && storedService !== "Unknown" ? storedService : currentService;

  if (!businessId || !knownService || knownService === "Unknown") {
    return {
      handled: true,
      result: fixedResult({
        reply:
          "I can check the business calendar for you. What service do you need help with?",
        category: "availability_inquiry",
      }),
    };
  }

  const pricingNote = await buildAvailabilityPricingNote({
    business,
    bookingState: conversation?.bookingState || null,
    lead,
    text,
  });
  let matches = [];
  try {
    matches = await searchServicesTool({
      businessId,
      query: knownService,
    });
  } catch (error) {
    return handleAvailabilityProviderFailure({ business, lead, conversation, error,
      customerMessage: text, code: 'service_catalog_lookup_failed', category: 'availability_inquiry' });
  }

  if (matches.length !== 1 || matches[0]?.score === 0) {
    if (matches.length > 1) {
      const choices = matches
        .slice(0, 3)
        .map((item) => item.name)
        .join(", ");
      return {
        handled: true,
        result: fixedResult({
          reply: `I have ${knownService}. I found these booking options: ${choices}. Which should I check first?`,
          category: "availability_inquiry",
        }),
      };
    }

    return {
      handled: true,
      result: fixedResult({
        reply: `${pricingNote ? `${pricingNote} ` : ""}I have ${knownService}. I can’t verify live availability for this job right now. ${/\bleak(?:ing|s)?\b/i.test(knownService) ? "Is water still leaking or spreading?" : lead?.preferredAppointmentTime ? "Your preferred time still needs business confirmation." : "What day and time would you prefer?"}`,
        category: "availability_inquiry",
      }),
    };
  }

  const service = matches[0];
  const requestedRange = findDateRange(text, timeZone);
  const today = formatDateKey(new Date(), timeZone);
  const previousRange = conversation?.bookingState?.searchStartDate && conversation?.bookingState?.searchEndDate
    ? { startDate: conversation.bookingState.searchStartDate, endDate: conversation.bookingState.searchEndDate }
    : findDateRange(lead?.preferredAppointmentTime || '', timeZone);
  const hasTime = hasAppointmentPreferenceHint(text, timeZone);
  const range = requestedRange || (hasTime ? previousRange : null) || {
    startDate: today,
    endDate: formatDateKey(new Date(Date.now() + 6 * 86_400_000), timeZone),
  };
  const timePreference = parseTimePreference(text, timeZone);
  const postalCode = extractCustomerPostalCode(lead?.address);
  if (conversation?.set && typeof conversation.save === 'function') {
    await updateState(conversation, { searchStartDate: range.startDate, searchEndDate: range.endDate });
  }

  try {
    const availability = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id,
      serviceOfferingId: service.id,
      startDate: range.startDate,
      endDate: range.endDate,
      postalCode,
    });

    if (availability?.supportedServiceArea === false) {
      return {
        handled: true,
        result: fixedResult({
          reply: `That location needs a service-area review before I can show bookable times. ${businessName} can confirm availability directly.`,
          category: "availability_inquiry",
        }),
      };
    }

    if (!Array.isArray(availability?.slots)) throw new Error('Invalid availability response');
    const rawSlots = filterAutomatedSlots(availability.slots);
    const matchingSlots = filterSlotsByTimePreference(
      rawSlots,
      timePreference,
      timeZone,
    );
    let offeredSlots = selectSlotOptions(
      matchingSlots,
      lead?.urgency,
      3,
    );

    if (!offeredSlots.length && range.startDate === today && range.endDate === today) {
      return { handled: true, result: await requestStaffSchedulingReview({ business, lead, conversation, customerMessage: text, channel }) };
    }
    let alternativeNote = '';
    let optionsLabel = 'Current openings';
    if (!offeredSlots.length) {
      const expandedStart = range.startDate > today ? range.startDate : today;
      const expanded = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id, serviceOfferingId: service.id,
        startDate: expandedStart, endDate: new Date(new Date(`${expandedStart}T12:00:00Z`).getTime() + 13 * 86_400_000).toISOString().slice(0, 10), postalCode });
      if (expanded?.supportedServiceArea !== false) {
        if (!Array.isArray(expanded?.slots)) throw new Error('Invalid expanded availability response');
        // Keep honoring the time the customer asked for. Only when nothing in
        // the next two weeks matches do we show the closest times, and we say
        // so plainly instead of blaming unnamed "scheduling rules".
        const expandedSlots = filterAutomatedSlots(expanded?.slots);
        const expandedMatches = filterSlotsByTimePreference(expandedSlots, timePreference, timeZone);
        const hasTimePreference = timePreference?.targetMinutes != null || Boolean(timePreference?.timeOfDay) ||
          timePreference?.windowStartMinutes != null || timePreference?.windowEndMinutes != null;
        if (expandedMatches.length) {
          offeredSlots = selectSlotOptions(expandedMatches, lead?.urgency, 3);
          alternativeNote = 'No matching time in the requested dates. ';
          optionsLabel = 'Closest matches';
        } else {
          offeredSlots = (timePreference?.targetMinutes != null
            ? rankSlotsByTimePreference(expandedSlots, timePreference, timeZone).slice(0, 3)
                .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
            : expandedSlots.slice(0, 3));
          if (offeredSlots.length) {
            alternativeNote = hasTimePreference
              ? `I don’t see an opening at that time in the two weeks starting ${expandedStart}. `
              : 'Nothing is open on that day. ';
            optionsLabel = hasTimePreference ? 'Closest openings' : 'Current openings';
          }
        }
      }
    }
    if (!offeredSlots.length) {
      const qualifier = timePreference?.timeOfDay
        ? ` ${timePreference.timeOfDay}`
        : "";
      return {
        handled: true,
        result: fixedResult({
          reply: `${pricingNote ? `${pricingNote} ` : ""}${automatedSchedulingNotice} I don’t see an eligible${qualifier} opening for ${service.name}. What later day could work?`,
          category: "availability_inquiry",
        }),
      };
    }

    // Keep the numbered options and approval caveat inside the SMS budget.
    offeredSlots = offeredSlots.slice(0, pricingNote ? 1 : 2);
    if (conversation?.set && typeof conversation.save === "function") {
      await updateState(conversation, {
        status: "offering_slots",
        serviceOffering: service.id,
        offeredSlots: offeredSlots.map((slot) => ({
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          timezone: timeZone,
          label: formatSlot(slot, timeZone),
          arrivalStartAt: slot.arrivalStartAt, arrivalEndAt: slot.arrivalEndAt,
          requiresBusinessApproval: slot.requiresBusinessApproval !== false,
          selectionSubmits: false,
        })),
        selectedSlot: null,
        availabilityInquiry: true,
        lastAvailabilityCheckedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
    }

    const options = offeredSlots
      .map((slot, index) => `${index + 1}) ${formatSlot(slot, timeZone)}`)
      .join("; ");

    return {
      handled: true,
      result: fixedResult({
        reply: `${pricingNote ? `${pricingNote} ` : ""}${alternativeNote}${optionsLabel}: ${options}. Which option works best? ${offeredSlots.some(slot => slot.requiresBusinessApproval !== false) ? 'Not a confirmed appointment; business approval required.' : 'Your choice will be checked before it is confirmed.'}`,
        category: "availability_inquiry",
      }),
    };
  } catch (error) {
    const failure = await handleAvailabilityProviderFailure({
      business,
      lead,
      conversation,
      error,
      customerMessage: text,
      code: "read_only_availability_provider_failed",
      category: "availability_inquiry",
    });
    failure.result.reply = `${pricingNote ? `${pricingNote} ` : ""}I can’t verify live availability right now. Your scheduling request needs team review; no appointment is confirmed.`;
    return failure;
  }
};

const handleAvailabilityProviderFailure = async ({
  business,
  lead,
  conversation,
  error,
  customerMessage = "",
  code = "availability_provider_failed",
  category = "human_requested",
}) => {
  if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
  assertVoiceTurnActive(); assertDistributedLeaseActive();
  logOperationalError(`booking.${code}`, error, {
    businessId: business?._id || business?.id,
    leadId: lead?._id || null,
    conversationId: conversation?._id || null,
    errorCode: String(error?.code || "AVAILABILITY_PROVIDER_ERROR"),
  });

  await AlertService.createSystemAlert({
    businessId: business._id,
    title: "Scheduling availability check failed",
    message:
      "CallBackIQ could not read the scheduling provider. The customer was not told the business had no openings.",
    priority: "high",
    metadata: {
      leadId: lead?._id ? String(lead._id) : "",
      conversationId: conversation?._id ? String(conversation._id) : "",
      errorCode: String(error?.code || "AVAILABILITY_PROVIDER_ERROR"),
      source: code,
      customerMessage: String(customerMessage || "").slice(0, 500),
    },
    dedupeKey: `booking_provider_failure:${business._id}:${conversation?._id || lead?._id || "unknown"}:${String(error?.code || code)}`,
  }).catch((alertError) => {
    logOperationalError("booking.provider_failure_alert_failed", alertError, {
      businessId: business?._id || business?.id,
      conversationId: conversation?._id || null,
    });
  });

  return {
    handled: true,
    result: fixedResult({
      reply:
        "I’m having trouble checking the live schedule right now. Your scheduling request needs team review; no appointment is confirmed.",
      category,
    }),
  };
};

const handleBookingReadinessFailure = async ({
  business,
  lead,
  conversation,
  readiness = null,
  error = null,
  customerMessage = "",
}) => {
  if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
  assertVoiceTurnActive(); assertDistributedLeaseActive();
  const missing = readiness?.missingRequirements?.booking || [];
  const firstMissing = missing[0] || null;

  if (error) {
    logOperationalError("booking.readiness_check_failed", error, {
      businessId: business?._id || business?.id,
      conversationId: conversation?._id || null,
    });
  } else {
    logOperationalEvent("booking.runtime_not_ready", {
      businessId: business?._id || business?.id,
      conversationId: conversation?._id || null,
      code: firstMissing?.code || "BOOKING_NOT_READY",
    });
  }

  await AlertService.createSystemAlert({
    businessId: business._id,
    title: "Automatic booking is not ready",
    message:
      firstMissing?.message ||
      "CallBackIQ blocked an automated booking attempt because required scheduling configuration is incomplete.",
    priority: "high",
    metadata: {
      leadId: lead?._id ? String(lead._id) : "",
      conversationId: conversation?._id ? String(conversation._id) : "",
      code: firstMissing?.code || error?.code || "BOOKING_NOT_READY",
      missingRequirements: missing.map((item) => item.code),
      customerMessage: String(customerMessage || "").slice(0, 500),
    },
    dedupeKey: `booking_not_ready:${business._id}:${firstMissing?.code || error?.code || "unknown"}`,
  }).catch((alertError) => {
    logOperationalError("booking.readiness_alert_failed", alertError, {
      businessId: business?._id || business?.id,
      conversationId: conversation?._id || null,
    });
  });

  return {
    handled: true,
    result: fixedResult({
      reply:
        "The scheduling system isn’t available for automatic booking right now. Your request needs team review; no appointment is confirmed.",
      category: "human_requested",
    }),
  };
};
  return { cleanStreetAddress, parseStreetAddress, buildAvailabilityPricingNote, formatSlot, handleReadOnlyAvailabilityInquiry, handleAvailabilityProviderFailure, handleBookingReadinessFailure };
}
