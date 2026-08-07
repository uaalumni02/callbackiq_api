import Appointment from "../../models/appointment.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import { formatDateKey } from "../scheduling/timezone.service.js";
import cancelAppointmentTool from "../../helpers/ai/tools/cancelAppointment.tool.js";
import createAppointmentTool from "../../helpers/ai/tools/createAppointment.tool.js";
import escalateToHumanTool from "../../helpers/ai/tools/escalateToHuman.tool.js";
import getAvailabilityTool from "../../helpers/ai/tools/getAvailability.tool.js";
import rescheduleAppointmentTool from "../../helpers/ai/tools/rescheduleAppointment.tool.js";
import searchServicesTool from "../../helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../../helpers/ai/tools/validateServiceArea.tool.js";

const BOOKING_INTENT = /\b(book|booking|schedule|appointment|available|availability|come out|visit)\b/i;
const AVAILABILITY_HINT = /\b(today|tomorrow|tmrw|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|tonight|after work|next week|\d{1,2}(?::\d{2})?\s*(?:am|pm)|20\d{2}-\d{2}-\d{2})\b/i;
const HUMAN_INTENT = /\b(human|person|representative|staff|someone|call me|talk to)\b/i;
const AFFIRMATIVE_TOKEN = /\b(yes|yep|yeah|yup|correct|confirm|confirmed|book it|please do|that works|works for me|sounds good|ok|okay|sure)\b/i;
const NEGATIVE_TOKEN = /\b(no|nope|not that|different|another|change it|cancel|do not|don't|not yet)\b/i;
const EXACT_PRICE = /\b(exact|final|total)\b.{0,25}\b(price|cost|quote|charge)\b|\bhow much (?:will|does) it cost\b/i;
const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;
const STREET_SUFFIX_PATTERN = /\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|parkway|pkwy|place|pl|way|trail|trl|circle|cir|highway|hwy|terrace|ter)\.?\b/i;
const TOMORROW_PATTERN = /\b(?:tomorrow|tmrw|tmr|tmw|2moro|2morrow|tomo)\b/i;

const isAffirmative = (value) => {
  const text = String(value || "").trim();
  return AFFIRMATIVE_TOKEN.test(text) && !NEGATIVE_TOKEN.test(text);
};

const isNegative = (value) => NEGATIVE_TOKEN.test(String(value || "").trim());

const cleanStreetAddress = (value) =>
  String(value || "")
    .trim()
    .replace(/^(?:yes|yeah|yep|sure|okay|ok)[,\s-]*/i, "")
    .replace(/^(?:it(?:'s| is)|the address is|address is|we(?:'re| are) at|i(?:'m| am) at|at)\s+/i, "")
    .replace(ZIP_PATTERN, "")
    .replace(/^[,;:\s-]+|[,;:\s-]+$/g, "")
    .replace(/\s{2,}/g, " ");

const parseStreetAddress = (value) => {
  const street = cleanStreetAddress(value);
  const hasStreetNumber = /^\d{1,7}[a-z]?\s+/i.test(street);
  const hasLetters = /[a-z]/i.test(street);
  const hasEnoughWords = street.split(/\s+/).filter(Boolean).length >= 3;
  const valid =
    hasStreetNumber &&
    hasLetters &&
    (STREET_SUFFIX_PATTERN.test(street) || hasEnoughWords);
  return { street, valid };
};

const fixedResult = ({
  reply,
  category = "appointment_preference",
  actionType = "send_fixed_response",
}) => ({
  decision: "send_fixed_response",
  actionType,
  messageCategory: category,
  reply,
  serviceNeeded: "",
  urgency: "medium",
  address: "",
  preferredAppointmentTime: "",
  leadQualityScore: 0,
  estimatedValue: 0,
  summary: "The deterministic booking state machine handled this message.",
  shouldAlertOwner: false,
  alertPriority: "low",
  alertTitle: "",
  alertMessage: "",
  riskFlags: [],
  confidence: 1,
  guardrail: {
    skipAI: true,
    reason: "booking_state_machine",
    usedFallback: false,
    violations: [],
  },
});

const formatSlot = (slot, timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(slot.startAt));

const findDateRange = (message, timeZone) => {
  const text = String(message || "");
  const explicitDates = text.match(/\b20\d{2}-\d{2}-\d{2}\b/g);

  if (explicitDates?.length) {
    return {
      startDate: explicitDates[0],
      endDate: explicitDates[1] || explicitDates[0],
    };
  }

  const now = new Date();
  const todayKey = formatDateKey(now, timeZone);
  const addDays = (days) => {
    const value = new Date(now.getTime() + days * 86_400_000);
    return formatDateKey(value, timeZone);
  };

  if (/\btoday\b/i.test(text)) {
    return { startDate: todayKey, endDate: todayKey };
  }

  if (TOMORROW_PATTERN.test(text)) {
    const key = addDays(1);
    return { startDate: key, endDate: key };
  }

  const weekdays = [
    { index: 0, pattern: /\b(?:sun|sunday)\b/i },
    { index: 1, pattern: /\b(?:mon|monday)\b/i },
    { index: 2, pattern: /\b(?:tue|tues|tuesday)\b/i },
    { index: 3, pattern: /\b(?:wed|weds|wednesday)\b/i },
    { index: 4, pattern: /\b(?:thu|thur|thurs|thursday)\b/i },
    { index: 5, pattern: /\b(?:fri|friday)\b/i },
    { index: 6, pattern: /\b(?:sat|saturday)\b/i },
  ];
  const matchedWeekday = weekdays.find(({ pattern }) => pattern.test(text));

  if (matchedWeekday) {
    const shortWeekday = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
    }).format(now);
    const weekdayIndex = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const current = weekdayIndex[shortWeekday] ?? 0;
    let daysAhead = (matchedWeekday.index - current + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    const key = addDays(daysAhead);
    return { startDate: key, endDate: key };
  }

  if (/\bnext\s+(?:wk|week)\b/i.test(text)) {
    return { startDate: addDays(7), endDate: addDays(13) };
  }

  return null;
};

const findTimeOfDay = (message) => {
  const text = String(message || "");
  if (/\b(?:early\s+)?morning\b/i.test(text)) return "morning";
  if (/\b(?:midday|noon|lunch(?:time)?)\b/i.test(text)) return "midday";
  if (/\bafternoon\b/i.test(text)) return "afternoon";
  if (/\b(?:evening|tonight|after\s+work)\b/i.test(text)) return "evening";
  return "";
};

const findRequestedClockMinutes = (message) => {
  const match = String(message || "").match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  return hour * 60 + Number(match[2] || 0);
};

const localClockMinutes = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(date));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
};

const localHour = (date, timeZone) =>
  Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(date))
      .find((part) => part.type === "hour")?.value,
  );

const filterSlotsByTimeOfDay = (slots, timeOfDay, timeZone) => {
  if (!timeOfDay) return slots;
  const windows = {
    morning: [6, 12],
    midday: [11, 14],
    afternoon: [12, 17],
    evening: [16, 21],
  };
  const [startHour, endHour] = windows[timeOfDay] || [0, 24];
  return slots.filter((slot) => {
    const hour = localHour(slot.startAt, timeZone);
    return Number.isFinite(hour) && hour >= startHour && hour < endHour;
  });
};

const spreadSlotOptions = (slots, maximum = 3) => {
  if (slots.length <= maximum) return slots;
  if (maximum <= 1) return [slots[0]];
  const indexes = Array.from({ length: maximum }, (_, index) =>
    Math.round((index * (slots.length - 1)) / (maximum - 1)),
  );
  return [...new Set(indexes)].map((index) => slots[index]);
};

const selectOfferedSlot = (message, offeredSlots, timeZone) => {
  const text = String(message || "").trim().toLowerCase();
  const explicitSelections = new Set();

  if (/\b(first|1|one)\b/.test(text)) explicitSelections.add(0);
  if (/\b(second|2|two)\b/.test(text)) explicitSelections.add(1);
  if (/\b(third|3|three)\b/.test(text)) explicitSelections.add(2);

  // A reply that names more than one option is ambiguous. Never choose one
  // appointment silently or advance to confirmation.
  if (explicitSelections.size > 1) return null;

  if (explicitSelections.size === 1) {
    const [selectedIndex] = explicitSelections;
    return offeredSlots[selectedIndex] || null;
  }

  return (
    offeredSlots.find((slot) => {
      const label = String(
        slot.label || formatSlot(slot, timeZone),
      ).toLowerCase();
      const localTime = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      })
        .format(new Date(slot.startAt))
        .toLowerCase();

      return text.includes(label) || text.includes(localTime);
    }) || null
  );
};

const updateState = async (conversation, changes) => {
  Object.entries(changes).forEach(([key, value]) => {
    conversation.set(`bookingState.${key}`, value);
  });
  await conversation.save();
};

class BookingStateMachineService {
  static async findConversation({ business, lead, conversation }) {
    if (conversation) return conversation;
    if (!lead?._id) return null;

    return Conversation.findOne({
      business: business._id,
      lead: lead._id,
      status: "open",
    }).sort({ lastMessageAt: -1 });
  }

  static async handle({
    business,
    lead,
    conversation,
    customerMessage,
    channel = "sms",
    source = "booking_state_machine",
  }) {
    const bookingChannel = channel === "voice" ? "voice" : "sms";
    const bookingSource = String(source || "booking_state_machine");
    const bookingIdempotencyPrefix =
      bookingChannel === "voice" ? "voice-" : "";
    const bookingEventPrefix = bookingChannel === "voice" ? "voice:" : "";
    const enabled = Boolean(business?.features?.aiBookingEnabled);
    if (!enabled) return { handled: false };

    const activeConversation = await this.findConversation({
      business,
      lead,
      conversation,
    });

    if (!activeConversation || activeConversation.humanTakeover) {
      return { handled: false };
    }

    const text = String(customerMessage || "").trim();
    const currentStatus =
      activeConversation.bookingState?.status || "not_started";
    const stateActive = currentStatus !== "not_started";

    if (
      !stateActive &&
      bookingChannel !== "voice" &&
      !BOOKING_INTENT.test(text) &&
      !AVAILABILITY_HINT.test(text)
    ) {
      return { handled: false };
    }

    if (HUMAN_INTENT.test(text)) {
      await escalateToHumanTool({
        businessId: business._id,
        leadId: lead?._id,
        conversationId: activeConversation._id,
        reason: "customer_requested_human",
        customerMessage: text,
      });

      return {
        handled: true,
        result: fixedResult({
          reply:
            "I’ve paused the automated booking and alerted the team. A person will follow up directly.",
          category: "human_requested",
        }),
      };
    }

    if (EXACT_PRICE.test(text)) {
      return {
        handled: true,
        result: fixedResult({
          reply:
            "I can help schedule the visit, but the team must confirm final scope and pricing after reviewing the job.",
          category: "pricing_request",
        }),
      };
    }

    let status = currentStatus;
    const offerExpired = Boolean(
      activeConversation.bookingState?.expiresAt &&
        activeConversation.bookingState.expiresAt < new Date(),
    );

    if (status === "failed" || offerExpired) {
      await updateState(activeConversation, {
        status: "collecting_service",
        offeredSlots: [],
        selectedSlot: null,
        negotiationAttempts: 0,
        lastCustomerPreference: text,
        lastAvailabilityCheckedAt: new Date(),
        expiresAt: null,
        lastError: "",
      });
      status = "collecting_service";

      // The customer's reply belongs to the stale offer. Return after the
      // reset so words such as "first" are not treated as a new service.
      if (offerExpired) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "That appointment offer expired. What service would you like to schedule?",
          }),
        };
      }
    }

    if (status === "not_started" || status === "collecting_service") {
      const serviceQuery =
        AVAILABILITY_HINT.test(text) && String(lead?.serviceNeeded || "").trim() && lead.serviceNeeded !== "Unknown"
          ? lead.serviceNeeded
          : text;
      const matches = await searchServicesTool({
        businessId: business._id,
        query: serviceQuery,
      });

      if (matches.length !== 1) {
        await updateState(activeConversation, {
          status: "collecting_service",
        });
        const choices = matches.length
          ? ` I found: ${matches.map((item) => item.name).join(", ")}.`
          : "";

        return {
          handled: true,
          result: fixedResult({
            reply: `What service would you like to schedule?${choices}`,
          }),
        };
      }

      const selectedService = matches[0];
      await updateState(activeConversation, {
        status: "collecting_location",
        serviceOffering: selectedService.id,
        streetAddress: "",
        postalCode: "",
      });

      if (lead && (!lead.serviceNeeded || lead.serviceNeeded === "Unknown")) {
        lead.serviceNeeded = selectedService.name;
        await lead.save();
      }

      return {
        handled: true,
        result: fixedResult({
          reply: `I can check times for ${selectedService.name}. I need the address and ZIP code in two steps. First, what is the street address for the service visit?`,
        }),
      };
    }

    if (
      status === "collecting_street_address" ||
      status === "collecting_location"
    ) {
      const { street, valid } = parseStreetAddress(text);
      const suppliedZip =
        text.match(ZIP_PATTERN)?.[1] ||
        activeConversation.bookingState?.postalCode ||
        "";

      if (!valid) {
        await updateState(activeConversation, {
          status: "collecting_street_address",
          ...(suppliedZip ? { postalCode: suppliedZip } : {}),
        });
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please send the street address, including the street number and street name—for example, 125 Main Street.",
          }),
        };
      }

      if (lead) {
        lead.address = street;
        await lead.save();
      }

      if (!suppliedZip) {
        await updateState(activeConversation, {
          status: "collecting_postal_code",
          streetAddress: street,
        });
        return {
          handled: true,
          result: fixedResult({
            reply: "Thanks. What is the 5-digit ZIP code for that address?",
          }),
        };
      }

      const area = await validateServiceAreaTool({
        businessId: business._id,
        postalCode: suppliedZip,
      });
      if (!area.supported) {
        await escalateToHumanTool({
          businessId: business._id,
          leadId: lead?._id,
          conversationId: activeConversation._id,
          reason: "unsupported_service_area",
          customerMessage: text,
        });
        return {
          handled: true,
          result: fixedResult({
            reply:
              "That ZIP code is outside the currently approved automated service area. I’ve sent the request to the team to review directly.",
            category: "service_area_question",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "collecting_preference",
        streetAddress: street,
        postalCode: suppliedZip,
      });
      return {
        handled: true,
        result: fixedResult({
          reply:
            "What day works best, and what time of day do you prefer? For example: Tues afternoon, tmrw morning, next week, or 2026-08-10.",
        }),
      };
    }

    if (status === "collecting_postal_code") {
      const zip = text.match(ZIP_PATTERN)?.[1];
      if (!zip) {
        return {
          handled: true,
          result: fixedResult({
            reply: "Please send the 5-digit ZIP code for the service address.",
          }),
        };
      }

      const area = await validateServiceAreaTool({
        businessId: business._id,
        postalCode: zip,
      });
      if (!area.supported) {
        await escalateToHumanTool({
          businessId: business._id,
          leadId: lead?._id,
          conversationId: activeConversation._id,
          reason: "unsupported_service_area",
          customerMessage: text,
        });
        return {
          handled: true,
          result: fixedResult({
            reply:
              "That ZIP code is outside the currently approved automated service area. I’ve sent the request to the team to review directly.",
            category: "service_area_question",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "collecting_preference",
        postalCode: zip,
      });
      return {
        handled: true,
        result: fixedResult({
          reply:
            "What day works best, and what time of day do you prefer? For example: Tues afternoon, tmrw morning, next week, or 2026-08-10.",
        }),
      };
    }

    if (status === "collecting_preference") {
      const timeZone = business.timezone || "America/New_York";
      const range = findDateRange(text, timeZone);
      const timeOfDay = findTimeOfDay(text);

      if (!range) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please tell me the day you prefer, such as Tues afternoon, tmrw morning, next week, or 2026-08-10.",
          }),
        };
      }

      const availability = await getAvailabilityTool({
        business,
        serviceOfferingId:
          activeConversation.bookingState.serviceOffering,
        startDate: range.startDate,
        endDate: range.endDate,
        postalCode: activeConversation.bookingState.postalCode,
      });
      const requestedClockMinutes = findRequestedClockMinutes(text);
      const dayPartSlots = filterSlotsByTimeOfDay(
        availability.slots,
        timeOfDay,
        timeZone,
      );
      const matchingSlots = requestedClockMinutes === null
        ? dayPartSlots
        : dayPartSlots.filter((slot) => localClockMinutes(slot.startAt, timeZone) === requestedClockMinutes);
      const offeredSlots = spreadSlotOptions(matchingSlots, 3);

      if (offeredSlots.length === 0) {
        const attempts = Number(activeConversation.bookingState?.negotiationAttempts || 0) + 1;
        const expandedRange = {
          startDate: range.startDate,
          endDate: formatDateKey(new Date(Date.now() + 14 * 86_400_000), timeZone),
        };
        let alternatives = [];
        try {
          const expanded = await getAvailabilityTool({
            business,
            serviceOfferingId: activeConversation.bookingState.serviceOffering,
            startDate: expandedRange.startDate,
            endDate: expandedRange.endDate,
            postalCode: activeConversation.bookingState.postalCode,
          });
          const expandedSlots = expanded.slots || [];
          alternatives = requestedClockMinutes === null
            ? spreadSlotOptions(expandedSlots, 3)
            : [...expandedSlots]
                .sort((a, b) => {
                  const aMinutes = localClockMinutes(a.startAt, timeZone);
                  const bMinutes = localClockMinutes(b.startAt, timeZone);
                  return Math.abs((aMinutes ?? 0) - requestedClockMinutes) - Math.abs((bMinutes ?? 0) - requestedClockMinutes);
                })
                .slice(0, 3);
        } catch {
          alternatives = [];
        }

        await updateState(activeConversation, {
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
          await updateState(activeConversation, {
            status: "human_takeover",
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
          await updateState(activeConversation, {
            status: "offering_slots",
            offeredSlots: alternatives.map((slot) => ({
              startAt: new Date(slot.startAt), endAt: new Date(slot.endAt), timezone: timeZone,
              label: formatSlot(slot, timeZone),
            })),
            expiresAt: new Date(Date.now() + 30 * 60_000),
          });
          return { handled: true, result: fixedResult({
            reply: `That time isn’t open, but I found ${options}. Which works best?`,
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

      await updateState(activeConversation, {
        status: "offering_slots",
        timeOfDay,
        preferredStart: new Date(offeredSlots[0].startAt),
        preferredEnd: new Date(
          offeredSlots[offeredSlots.length - 1].endAt,
        ),
        offeredSlots: offeredSlots.map((slot) => ({
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          timezone: timeZone,
          label: formatSlot(slot, timeZone),
        })),
        selectedSlot: null,
        negotiationAttempts: 0,
        lastCustomerPreference: text,
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

      return {
        handled: true,
        result: fixedResult({
          reply: `I have ${options}. Which option works best?`,
        }),
      };
    }

    if (status === "offering_slots") {
      const slot = selectOfferedSlot(
        text,
        activeConversation.bookingState.offeredSlots || [],
        business.timezone || "America/New_York",
      );

      if (!slot) {
        if (findDateRange(text, business.timezone || "America/New_York")) {
          await updateState(activeConversation, {
            status: "collecting_preference",
          });
          return this.handle({
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

      await updateState(activeConversation, {
        status: "awaiting_confirmation",
        selectedSlot: slot,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });

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
          reply: `Just to confirm, would you like me to book ${formatSlot(
            slot,
            business.timezone || "America/New_York",
          )} for ${serviceName} at ${address}? Reply YES to confirm.`,
        }),
      };
    }

    if (status === "awaiting_confirmation") {
      if (isNegative(text)) {
        await updateState(activeConversation, {
          status: "collecting_preference",
          selectedSlot: null,
          offeredSlots: [],
          expiresAt: null,
        });

        return {
          handled: true,
          result: fixedResult({
            reply: "No problem. What other day would you prefer?",
          }),
        };
      }

      if (!isAffirmative(text)) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please reply YES to book that exact time, or NO to choose another day.",
          }),
        };
      }

      const selectedSlot = activeConversation.bookingState.selectedSlot;
      await updateState(activeConversation, { status: "booking" });

      try {
        const bookingInput = {
          lead: lead?._id,
          conversation: activeConversation._id,
          serviceOfferingId:
            activeConversation.bookingState.serviceOffering,
          customerName:
            lead?.customerName || activeConversation.customerName,
          customerPhone:
            lead?.phone || activeConversation.customerPhone,
          customerEmail: lead?.email || "",
          address: {
            street:
              activeConversation.bookingState.streetAddress ||
              lead?.address ||
              "",
            postalCode: activeConversation.bookingState.postalCode,
          },
          startAt: selectedSlot.startAt,
          endAt: selectedSlot.endAt,
          timezone: business.timezone || "America/New_York",
          estimatedValue: lead?.estimatedValue || 0,
          source: bookingChannel,
          bookedBy: "ai",
        };
        const isReschedule =
          activeConversation.bookingState.lastError ===
            "reschedule_requested" &&
          activeConversation.bookingState.appointment;
        const appointment = isReschedule
          ? await rescheduleAppointmentTool({
              business,
              appointmentId:
                activeConversation.bookingState.appointment,
              input: bookingInput,
              idempotencyKey: `${bookingIdempotencyPrefix}ai-reschedule:${activeConversation._id}:${new Date(
                selectedSlot.startAt,
              ).toISOString()}`,
            })
          : await createAppointmentTool({
              business,
              idempotencyKey: `${bookingIdempotencyPrefix}ai-book:${activeConversation._id}:${new Date(
                selectedSlot.startAt,
              ).toISOString()}`,
              input: bookingInput,
            });

        if (appointment.status !== "confirmed") {
          throw new Error(
            "The appointment provider did not return a confirmed appointment.",
          );
        }

        await updateState(activeConversation, {
          status: "booked",
          appointment: appointment._id,
          expiresAt: null,
          lastError: "",
        });

        return {
          handled: true,
          result: fixedResult({
            reply: `You’re booked for ${formatSlot(
              appointment,
              appointment.timezone,
            )} for ${
              lead?.serviceNeeded || "your service request"
            }. Final scope and pricing may require technician evaluation. Reply here if you need to cancel or reschedule.`,
          }),
        };
      } catch (error) {
        await updateState(activeConversation, {
          status: "failed",
          lastError: error.message,
          expiresAt: null,
        });

        return {
          handled: true,
          result: fixedResult({
            reply:
              error.safeCustomerMessage ||
              "I’m having trouble confirming that appointment right now. I’ve sent your request to the team so they can confirm it directly.",
          }),
        };
      }
    }

    if (status === "booked") {
      const appointmentId = activeConversation.bookingState.appointment;

      // Destructive or schedule-changing intent takes precedence over a casual
      // affirmative word (for example, "sure, but I need to reschedule").
      if (/\bcancel\b/i.test(text)) {
        try {
          await cancelAppointmentTool({
            business,
            appointmentId,
            reason: `Customer requested cancellation by ${
              bookingChannel === "sms" ? "SMS" : "voice"
            }.`,
          });
          await updateState(activeConversation, {
            status: "not_started",
            appointment: null,
            selectedSlot: null,
            offeredSlots: [],
            expiresAt: null,
            lastError: "",
          });

          return {
            handled: true,
            result: fixedResult({
              reply:
                "Your appointment has been canceled. Reply with a new preferred day if you’d like to reschedule.",
            }),
          };
        } catch (error) {
          return {
            handled: true,
            result: fixedResult({
              reply:
                "I couldn’t confirm the cancellation automatically. I’ve alerted the team to handle it directly.",
            }),
          };
        }
      }

      if (
        /^\s*r\s*$/i.test(text) ||
        /\breschedule|change (?:the )?(?:time|day|appointment)\b/i.test(text)
      ) {
        await Appointment.updateOne(
          { _id: appointmentId, business: business._id },
          { $set: { customerRescheduleRequestedAt: new Date() } },
        );
        await updateState(activeConversation, {
          status: "collecting_preference",
          lastError: "reschedule_requested",
        });

        return {
          handled: true,
          result: fixedResult({
            reply:
              "What new day and time of day would you prefer? For example: Tues afternoon or tmrw morning.",
          }),
        };
      }

      // Reminder messages explicitly ask for C or R. Do not treat a repeated
      // conversational YES after booking as a second confirmation action.
      if (/^\s*c\s*$/i.test(text)) {
        const confirmed = await Appointment.findOneAndUpdate(
          {
            _id: appointmentId,
            business: business._id,
            status: "confirmed",
          },
          {
            $set: { customerConfirmedAt: new Date() },
          },
          { new: true },
        );
        if (confirmed) {
          return {
            handled: true,
            result: fixedResult({
              reply: `Thank you—your appointment for ${formatSlot(
                confirmed,
                confirmed.timezone,
              )} is confirmed.`,
            }),
          };
        }
      }

      return { handled: false };
    }

    return { handled: false };
  }
}

export default BookingStateMachineService;
