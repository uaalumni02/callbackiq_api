import { classifySmsIntent } from "../messaging/smsIntentClassifier.service.js";
import Appointment from "../../models/appointment.js";
import Conversation from "../../models/conversation.js";
import Lead from "../../models/lead.js";
import ServiceOffering from "../../models/serviceOffering.js";
import AutomationTriggerService from "../automation/automationTrigger.service.js";
import ConversionEventService from "../conversionEvent.service.js";
import AlertService from "../alert.service.js";
import { buildBusinessReadiness } from "../businessReadiness.service.js";
import { logOperationalError, logOperationalEvent } from "../../helpers/logging/safeLogger.js";
import { formatDateKey } from "../scheduling/timezone.service.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import cancelAppointmentTool from "../../helpers/ai/tools/cancelAppointment.tool.js";
import createAppointmentTool from "../../helpers/ai/tools/createAppointment.tool.js";
import escalateToHumanTool from "../../helpers/ai/tools/escalateToHuman.tool.js";
import getAvailabilityTool from "../../helpers/ai/tools/getAvailability.tool.js";
import rescheduleAppointmentTool from "../../helpers/ai/tools/rescheduleAppointment.tool.js";
import searchServicesTool from "../../helpers/ai/tools/searchServices.tool.js";
import validateServiceAreaTool from "../../helpers/ai/tools/validateServiceArea.tool.js";
import {
  filterSlotsByTimePreference,
  findDateRange,
  hasAppointmentPreferenceHint,
  parseTimePreference,
  rankSlotsByTimePreference,
} from "./appointmentPreferenceParser.service.js";

const BOOKING_INTENT = /\b(book|booking|schedule|appointment|available|availability|come out|visit)\b/i;
const AVAILABILITY_HINT = /\b(today|tomorrow|tmrw|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|tonight|after work|next week|\d{1,2}(?::\d{2})?\s*(?:am|pm)|20\d{2}-\d{2}-\d{2})\b/i;
const hasBookingAvailabilityHint = (value, timeZone = "America/New_York") =>
  AVAILABILITY_HINT.test(String(value || "")) ||
  hasAppointmentPreferenceHint(value, timeZone);
const HUMAN_INTENT = /\b(human|person|representative|staff|someone|call me|talk to)\b/i;
const AFFIRMATIVE_TOKEN = /\b(yes|yep|yeah|yup|correct|confirm|confirmed|book it|please do|that works|works for me|sounds good|ok|okay|sure)\b/i;
const NEGATIVE_TOKEN = /\b(no|nope|not that|different|another|change it|cancel|do not|don't|not yet)\b/i;
const PRICE_INTENT = /\b(price|pricing|cost|estimate|estimated|quote|ballpark|how much|rate|charge)\b/i;
const EXACT_PRICE = /\b(exact|final|total)\b.{0,25}\b(price|cost|quote|charge)\b|\bhow much (?:will|does) it cost\b/i;
const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;
const STREET_SUFFIX_PATTERN = /\b(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|parkway|pkwy|place|pl|way|trail|trl|circle|cir|highway|hwy|terrace|ter)\.?\b/i;

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

const formatCurrency = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value));

const resolvePricingService = async ({
  businessId,
  bookingState,
  lead,
  text,
}) => {
  if (bookingState?.serviceOffering) {
    return ServiceOffering.findOne({
      _id: bookingState.serviceOffering,
      business: businessId,
      active: true,
      aiCanDiscuss: true,
    }).lean();
  }

  const matches = await searchServicesTool({
    businessId,
    query: String(lead?.serviceNeeded || "").trim() || text,
  });
  if (matches.length !== 1) return null;

  return ServiceOffering.findOne({
    _id: matches[0].id,
    business: businessId,
    active: true,
    aiCanDiscuss: true,
  }).lean();
};

const buildApprovedPriceEstimate = (service) => {
  if (!service?.disclosePriceEstimate) return "";

  const min =
    service.priceEstimateMin == null ? null : Number(service.priceEstimateMin);
  const max =
    service.priceEstimateMax == null ? null : Number(service.priceEstimateMax);
  let range = "";

  if (Number.isFinite(min) && Number.isFinite(max)) {
    range =
      min === max
        ? `around ${formatCurrency(min)}`
        : `roughly ${formatCurrency(min)}–${formatCurrency(max)}`;
  } else if (Number.isFinite(min)) {
    range = `starting around ${formatCurrency(min)}`;
  } else if (Number.isFinite(max)) {
    range = `typically up to about ${formatCurrency(max)}`;
  }

  if (!range) return "";

  const diagnostic =
    service.discloseDiagnosticFee && service.diagnosticFee != null
      ? ` A diagnostic/service-call fee of ${formatCurrency(
          service.diagnosticFee,
        )} may apply.`
      : "";
  const disclaimer =
    String(service.priceEstimateDisclaimer || "").trim() ||
    "This is a rough estimate only. Final pricing depends on the actual scope, site conditions, parts, and technician evaluation.";

  return `For ${service.name}, the business-approved rough estimate is ${range}.${diagnostic} ${disclaimer}`;
};

const formatSlot = (slot, timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(slot.startAt));

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

const handleReadOnlyAvailabilityInquiry = async ({
  business,
  lead,
  conversation,
  text,
}) => {
  const businessName = String(
    business?.businessName || "the business",
  ).trim();
  const businessId = business?._id || business?.id;
  const timeZone = business?.timezone || "America/New_York";
  const knownService = String(lead?.serviceNeeded || "").trim();

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

  let matches = [];
  try {
    matches = await searchServicesTool({
      businessId,
      query: knownService,
    });
  } catch {
    matches = [];
  }

  if (matches.length !== 1) {
    if (matches.length > 1) {
      const choices = matches
        .slice(0, 3)
        .map((item) => item.name)
        .join(", ");
      return {
        handled: true,
        result: fixedResult({
          reply: `I can check live availability, but I need to match the job to the right service first. I found: ${choices}. Which service do you need?`,
          category: "availability_inquiry",
        }),
      };
    }

    return {
      handled: true,
      result: fixedResult({
        reply: `I can’t verify live availability for that service right now. Tell me the day and time you prefer, and ${businessName} can confirm it.`,
        category: "availability_inquiry",
      }),
    };
  }

  const service = matches[0];
  const requestedRange = findDateRange(text, timeZone);
  const today = formatDateKey(new Date(), timeZone);
  const range = requestedRange || {
    startDate: today,
    endDate: formatDateKey(new Date(Date.now() + 6 * 86_400_000), timeZone),
  };
  const timePreference = parseTimePreference(text, timeZone);
  const postalCode = String(lead?.address || "").match(ZIP_PATTERN)?.[1] || "";

  try {
    const availability = await getAvailabilityTool({
      business,
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

    const rawSlots = Array.isArray(availability?.slots)
      ? [...availability.slots].sort(
          (left, right) =>
            new Date(left.startAt).getTime() - new Date(right.startAt).getTime(),
        )
      : [];
    const matchingSlots = filterSlotsByTimePreference(
      rawSlots,
      timePreference,
      timeZone,
    );
    const offeredSlots = spreadSlotOptions(matchingSlots, 3);

    if (!offeredSlots.length) {
      const qualifier = timePreference?.timeOfDay
        ? ` ${timePreference.timeOfDay}`
        : "";
      return {
        handled: true,
        result: fixedResult({
          reply: `I checked the current calendar and don’t see an open${qualifier} time in that window for ${service.name}. Send another day or time and I can check that window.`,
          category: "availability_inquiry",
        }),
      };
    }

    const options = offeredSlots
      .map((slot) => formatSlot(slot, timeZone))
      .join("; ");

    return {
      handled: true,
      result: fixedResult({
        reply: `I found these current openings for ${service.name}: ${options}. If one works, reply with the day and time you want. This is availability only, not a confirmed appointment; ${businessName} will confirm your request.`,
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
    failure.result.reply =
      "I can’t verify live availability right now. I’ve alerted the team so they can follow up with available times.";
    return failure;
  }
};

// CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: calendar/provider failure is never represented as zero availability.
const handleAvailabilityProviderFailure = async ({
  business,
  lead,
  conversation,
  error,
  customerMessage = "",
  code = "availability_provider_failed",
  category = "human_requested",
}) => {
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
        "I’m having trouble checking the live schedule right now. I’ve alerted the team so they can follow up with available times.",
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
        "The scheduling system isn’t available for automatic booking right now. I’ve alerted the team so they can follow up with you directly.",
      category: "human_requested",
    }),
  };
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
    const text = String(customerMessage || "").trim();

    if (!enabled) {
      const smsIntent = classifySmsIntent({
        customerMessage: text,
        business,
        conversation,
      });

      if (
        bookingChannel === "sms" &&
        smsIntent.intents.availabilityInquiry
      ) {
        return handleReadOnlyAvailabilityInquiry({
          business,
          lead,
          conversation,
          text,
        });
      }

      return { handled: false };
    }

    const activeConversation = await this.findConversation({
      business,
      lead,
      conversation,
    });

    if (!activeConversation || activeConversation.humanTakeover) {
      return { handled: false };
    }

    const smsIntent = classifySmsIntent({
      customerMessage: text,
      business,
      conversation: activeConversation,
    });
    const currentStatus =
      activeConversation.bookingState?.status || "not_started";
    const stateActive = currentStatus !== "not_started";

    if (
      !stateActive &&
      bookingChannel !== "voice" &&
      !smsIntent.intents.scheduling &&
      !hasBookingAvailabilityHint(text, business.timezone || "America/New_York")
    ) {
      return { handled: false };
    }

    if (smsIntent.intents.human) {
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

    if (smsIntent.intents.pricing) {
      const pricingService = await resolvePricingService({
        businessId: business._id,
        bookingState: activeConversation.bookingState,
        lead,
        text,
      });
      const approvedEstimate = buildApprovedPriceEstimate(pricingService);

      return {
        handled: true,
        result: fixedResult({
          reply:
            approvedEstimate ||
            (EXACT_PRICE.test(text)
              ? "I can help schedule the visit, but the team must confirm final scope and pricing after reviewing the job."
              : "I don’t have a business-approved price range for that service, so I don’t want to guess. I can still help schedule a visit so the team can assess the job and confirm pricing."),
          category: "pricing_request",
        }),
      };
    }

    // CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: feature flag alone is insufficient; booking must be operationally ready now.
    let runtimeReadiness;
    try {
      runtimeReadiness = await buildBusinessReadiness(business, {
        persist: false,
      });
    } catch (error) {
      return handleBookingReadinessFailure({
        business,
        lead,
        conversation: activeConversation,
        error,
        customerMessage: text,
      });
    }

    if (!runtimeReadiness?.states?.bookingReady) {
      return handleBookingReadinessFailure({
        business,
        lead,
        conversation: activeConversation,
        readiness: runtimeReadiness,
        customerMessage: text,
      });
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
        hasBookingAvailabilityHint(text, business.timezone || "America/New_York") && String(lead?.serviceNeeded || "").trim() && lead.serviceNeeded !== "Unknown"
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
            "What day and time work best? You can text naturally—for example: tomorrow at 2, day after tomorrow around 3ish, Friday morning, Aug 10 at 2:30, or after work.",
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
            "What day and time work best? You can text naturally—for example: tomorrow at 2, day after tomorrow around 3ish, Friday morning, Aug 10 at 2:30, or after work.",
        }),
      };
    }

    if (status === "collecting_preference") {
      const timeZone = business.timezone || "America/New_York";
      const range = findDateRange(text, timeZone);
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

      let availability;
      try {
        availability = await getAvailabilityTool({
          business,
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
        availability.slots,
        timePreference,
        timeZone,
      );
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
          const expandedMatches = filterSlotsByTimePreference(
            expandedSlots,
            timePreference,
            timeZone,
          );
          alternatives = expandedMatches.length
            ? spreadSlotOptions(expandedMatches, 3)
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
            reply: `That requested time is outside the current bookable availability or is already taken, but I found ${options}. Which works best?`,
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
      if (smsIntent.response.negative) {
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

      if (!smsIntent.response.affirmative) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Please reply YES to book that exact time, or NO to choose another day.",
          }),
        };
      }

      const selectedSlot = activeConversation.bookingState.selectedSlot;
      assertVoiceTurnActive();
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
        assertVoiceTurnActive();
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

        assertVoiceTurnActive();
        if (
          appointment.status === "held" &&
          appointment.requiresBusinessApproval === true
        ) {
          await updateState(activeConversation, {
            status: "pending_business_confirmation",
            appointment: appointment._id,
            expiresAt: appointment.heldExpiresAt || null,
            lastError: "",
          });

          return {
            handled: true,
            result: fixedResult({
              reply: `I’ve reserved ${formatSlot(
                appointment,
                appointment.timezone,
              )} for ${
                lead?.serviceNeeded || "your service request"
              } pending business approval. The team will text you as soon as they accept the appointment.`,
            }),
          };
        }

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

    if (status === "pending_business_confirmation") {
      const appointmentId = activeConversation.bookingState.appointment;
      const appointment = appointmentId
        ? await Appointment.findOne({
            _id: appointmentId,
            business: business._id,
          })
        : null;

      if (appointment?.status === "confirmed") {
        await updateState(activeConversation, {
          status: "booked",
          expiresAt: null,
          lastError: "",
        });
        return {
          handled: true,
          result: fixedResult({
            reply: `Your appointment is confirmed for ${formatSlot(
              appointment,
              appointment.timezone,
            )}. Reply here if you need to reschedule or cancel.`,
          }),
        };
      }

      if (appointment?.status === "held") {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "Your requested appointment is still awaiting business approval. The team will text you as soon as it is accepted.",
          }),
        };
      }

      await updateState(activeConversation, {
        status: "collecting_preference",
        appointment: null,
        selectedSlot: null,
        offeredSlots: [],
        expiresAt: null,
        lastError: "business_approval_unavailable",
      });
      return {
        handled: true,
        result: fixedResult({
          reply:
            "That appointment request could not be confirmed. What other day or time works for you?",
        }),
      };
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
              "What new day and time would you prefer? You can text naturally—for example: tomorrow at 2, next Friday morning, or day after tomorrow around 3ish.",
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
