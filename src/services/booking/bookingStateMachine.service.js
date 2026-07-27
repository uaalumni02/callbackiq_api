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
const HUMAN_INTENT = /\b(human|person|representative|staff|someone|call me|talk to)\b/i;
const AFFIRMATIVE = /^(yes|yep|yeah|correct|confirm|confirmed|book it|please do|that works|sounds good|ok|okay|sure)[.!\s]*$/i;
const NEGATIVE = /^(no|nope|not that|different|another|change it|cancel)[.!\s]*$/i;
const EXACT_PRICE = /\b(exact|final|total)\b.{0,25}\b(price|cost|quote|charge)\b|\bhow much (?:will|does) it cost\b/i;
const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;

const fixedResult = ({ reply, category = "appointment_preference", actionType = "send_fixed_response" }) => ({
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
  const explicitDates = String(message).match(/\b20\d{2}-\d{2}-\d{2}\b/g);
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
  if (/\btoday\b/i.test(message)) return { startDate: todayKey, endDate: todayKey };
  if (/\btomorrow\b/i.test(message)) {
    const key = addDays(1);
    return { startDate: key, endDate: key };
  }

  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const wanted = weekdays.findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(message));
  if (wanted >= 0) {
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
    let daysAhead = (wanted - current + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    const key = addDays(daysAhead);
    return { startDate: key, endDate: key };
  }

  if (/\bnext week\b/i.test(message)) {
    return { startDate: addDays(7), endDate: addDays(13) };
  }

  return null;
};

const selectOfferedSlot = (message, offeredSlots, timeZone) => {
  const text = String(message || "").trim().toLowerCase();
  if (/\b(first|1|one)\b/.test(text)) return offeredSlots[0] || null;
  if (/\b(second|2|two)\b/.test(text)) return offeredSlots[1] || null;
  if (/\b(third|3|three)\b/.test(text)) return offeredSlots[2] || null;

  return (
    offeredSlots.find((slot) => {
      const label = String(slot.label || formatSlot(slot, timeZone)).toLowerCase();
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

  static async handle({ business, lead, conversation, customerMessage }) {
    const enabled = Boolean(business?.features?.aiBookingEnabled);
    if (!enabled) return { handled: false };

    const activeConversation = await this.findConversation({ business, lead, conversation });
    if (!activeConversation || activeConversation.humanTakeover) return { handled: false };

    const text = String(customerMessage || "").trim();
    const currentStatus = activeConversation.bookingState?.status || "not_started";
    const stateActive = currentStatus !== "not_started";

    if (!stateActive && !BOOKING_INTENT.test(text)) return { handled: false };

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
          reply: "I’ve paused the automated booking and alerted the team. A person will follow up directly.",
          category: "human_requested",
        }),
      };
    }

    if (EXACT_PRICE.test(text)) {
      return {
        handled: true,
        result: fixedResult({
          reply: "I can help schedule the visit, but the team must confirm final scope and pricing after reviewing the job.",
          category: "pricing_request",
        }),
      };
    }

    let status = currentStatus;
    if (status === "failed" || (activeConversation.bookingState?.expiresAt && activeConversation.bookingState.expiresAt < new Date())) {
      await updateState(activeConversation, {
        status: "collecting_service",
        offeredSlots: [],
        selectedSlot: null,
        expiresAt: null,
        lastError: "",
      });
      status = "collecting_service";
    }

    if (status === "not_started" || status === "collecting_service") {
      const matches = await searchServicesTool({ businessId: business._id, query: text });
      if (matches.length !== 1) {
        await updateState(activeConversation, { status: "collecting_service" });
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
      });
      if (lead && (!lead.serviceNeeded || lead.serviceNeeded === "Unknown")) {
        lead.serviceNeeded = selectedService.name;
        await lead.save();
      }
      return {
        handled: true,
        result: fixedResult({
          reply: `I can check times for ${selectedService.name}. What is the service address and ZIP code?`,
        }),
      };
    }

    if (status === "collecting_location") {
      const zip = text.match(ZIP_PATTERN)?.[1] || activeConversation.bookingState?.postalCode;
      if (!zip) {
        return {
          handled: true,
          result: fixedResult({ reply: "Please send the service address and 5-digit ZIP code." }),
        };
      }

      const area = await validateServiceAreaTool({ businessId: business._id, postalCode: zip });
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
            reply: "That ZIP code is outside the currently approved automated service area. I’ve sent the request to the team to review directly.",
            category: "service_area_question",
          }),
        };
      }

      if (lead && text.length > 5) {
        lead.address = text;
        await lead.save();
      }
      await updateState(activeConversation, {
        status: "collecting_preference",
        postalCode: zip,
      });
      return {
        handled: true,
        result: fixedResult({
          reply: "What day works best? You can reply with a weekday, tomorrow, next week, or a date like 2026-08-03.",
        }),
      };
    }

    if (status === "collecting_preference") {
      const timeZone = business.timezone || "America/New_York";
      const range = findDateRange(text, timeZone);
      if (!range) {
        return {
          handled: true,
          result: fixedResult({
            reply: "Please tell me the day you prefer, such as Tuesday, tomorrow, next week, or 2026-08-03.",
          }),
        };
      }

      const availability = await getAvailabilityTool({
        business,
        serviceOfferingId: activeConversation.bookingState.serviceOffering,
        startDate: range.startDate,
        endDate: range.endDate,
        postalCode: activeConversation.bookingState.postalCode,
      });
      const offeredSlots = availability.slots.slice(0, 3);
      if (offeredSlots.length === 0) {
        return {
          handled: true,
          result: fixedResult({
            reply: "I don’t see an available time in that window. Please send another day or date range.",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "offering_slots",
        preferredStart: new Date(offeredSlots[0].startAt),
        preferredEnd: new Date(offeredSlots[offeredSlots.length - 1].endAt),
        offeredSlots: offeredSlots.map((slot) => ({
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          timezone: timeZone,
          label: formatSlot(slot, timeZone),
        })),
        selectedSlot: null,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      await ConversionEventService.record({
        businessId: business._id,
        leadId: lead?._id,
        conversationId: activeConversation._id,
        type: "appointment_offered",
        channel: "sms",
        source: "booking_state_machine",
        idempotencyKey: `appointment_offered:${activeConversation._id}:${offeredSlots[0].startAt}`,
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
        .map((slot, index) => `${index + 1}) ${formatSlot(slot, timeZone)}`)
        .join("; ");
      return {
        handled: true,
        result: fixedResult({ reply: `I have ${options}. Which option works best?` }),
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
          await updateState(activeConversation, { status: "collecting_preference" });
          return this.handle({ business, lead, conversation: activeConversation, customerMessage: text });
        }
        return {
          handled: true,
          result: fixedResult({ reply: "Please reply with the option number, or send another day." }),
        };
      }

      await updateState(activeConversation, {
        status: "awaiting_confirmation",
        selectedSlot: slot,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      const serviceName = lead?.serviceNeeded || "the requested service";
      const address = lead?.address || `ZIP ${activeConversation.bookingState.postalCode}`;
      return {
        handled: true,
        result: fixedResult({
          reply: `Just to confirm, would you like me to book ${formatSlot(slot, business.timezone || "America/New_York")} for ${serviceName} at ${address}? Reply YES to confirm.`,
        }),
      };
    }

    if (status === "awaiting_confirmation") {
      if (NEGATIVE.test(text)) {
        await updateState(activeConversation, {
          status: "collecting_preference",
          selectedSlot: null,
          offeredSlots: [],
          expiresAt: null,
        });
        return {
          handled: true,
          result: fixedResult({ reply: "No problem. What other day would you prefer?" }),
        };
      }
      if (!AFFIRMATIVE.test(text)) {
        return {
          handled: true,
          result: fixedResult({ reply: "Please reply YES to book that exact time, or NO to choose another day." }),
        };
      }

      const selectedSlot = activeConversation.bookingState.selectedSlot;
      await updateState(activeConversation, { status: "booking" });
      try {
        const bookingInput = {
          lead: lead?._id,
          conversation: activeConversation._id,
          serviceOfferingId: activeConversation.bookingState.serviceOffering,
          customerName: lead?.customerName || activeConversation.customerName,
          customerPhone: lead?.phone || activeConversation.customerPhone,
          customerEmail: lead?.email || "",
          address: {
            street: lead?.address || "",
            postalCode: activeConversation.bookingState.postalCode,
          },
          startAt: selectedSlot.startAt,
          endAt: selectedSlot.endAt,
          timezone: business.timezone || "America/New_York",
          estimatedValue: lead?.estimatedValue || 0,
        };
        const isReschedule =
          activeConversation.bookingState.lastError === "reschedule_requested" &&
          activeConversation.bookingState.appointment;
        const appointment = isReschedule
          ? await rescheduleAppointmentTool({
              business,
              appointmentId: activeConversation.bookingState.appointment,
              input: bookingInput,
              idempotencyKey: `ai-reschedule:${activeConversation._id}:${new Date(selectedSlot.startAt).toISOString()}`,
            })
          : await createAppointmentTool({
              business,
              idempotencyKey: `ai-book:${activeConversation._id}:${new Date(selectedSlot.startAt).toISOString()}`,
              input: bookingInput,
            });

        if (appointment.status !== "confirmed") {
          throw new Error("The appointment provider did not return a confirmed appointment.");
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
            reply: `You’re booked for ${formatSlot(appointment, appointment.timezone)} for ${lead?.serviceNeeded || "your service request"}. Final scope and pricing may require technician evaluation. Reply here if you need to cancel or reschedule.`,
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
      if (/\bcancel\b/i.test(text)) {
        try {
          await cancelAppointmentTool({
            business,
            appointmentId,
            reason: "Customer requested cancellation by SMS.",
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
            result: fixedResult({ reply: "Your appointment has been canceled. Reply with a new preferred day if you’d like to reschedule." }),
          };
        } catch (error) {
          return {
            handled: true,
            result: fixedResult({
              reply: "I couldn’t confirm the cancellation automatically. I’ve alerted the team to handle it directly.",
            }),
          };
        }
      }
      if (/\breschedule|change (?:the )?(?:time|day|appointment)\b/i.test(text)) {
        await updateState(activeConversation, {
          status: "collecting_preference",
          lastError: "reschedule_requested",
        });
        return {
          handled: true,
          result: fixedResult({ reply: "What new day would you prefer?" }),
        };
      }
      return { handled: false };
    }

    return { handled: false };
  }
}

export default BookingStateMachineService;
