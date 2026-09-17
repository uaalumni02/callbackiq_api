import { handleConversationControl } from '../conversationControl.service.js';
import { extractCustomerAddress, normalizeSpokenAddress } from './customerAddress.service.js';
import { getApprovedServiceEstimate } from './approvedServiceEstimate.service.js';
import { guardServiceRequest } from '../serviceEligibility/serviceEligibility.service.js';
import { requestStaffSchedulingReview } from "./staffSchedulingReview.service.js";
import { schedulingQuestionReply } from "./schedulingQuestions.service.js";
import { bookingQuestionReply } from "./conversationQuestions.service.js";
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
import { assertDistributedLeaseActive } from "../distributedLease.service.js";
import { filterAutomatedSlots, automatedSchedulingNotice } from '../scheduling/automatedSchedulingPolicy.service.js';
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
const EXACT_PRICE = /\b(exact|final|total)\b.{0,25}\b(price|cost|quote|charge)\b|\bhow much (?:will|does) it cost\b/i;
const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;

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

const parseStreetAddress = value => {
  const address = extractCustomerAddress(String(value || '').replace(/^(?:yes|yeah|yep|sure|okay|ok)[,\s-]*/i, ''), { expected: true });
  return { street: cleanStreetAddress(address), valid: Boolean(address) };
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

const selectSlotOptions = (slots, urgency = "medium", maximum = 3) => {
  const chronological = [...(Array.isArray(slots) ? slots : [])].sort(
    (left, right) =>
      new Date(left.startAt).getTime() - new Date(right.startAt).getTime(),
  );

  return ["high", "emergency"].includes(String(urgency || "").toLowerCase())
    ? chronological.slice(0, maximum)
    : spreadSlotOptions(chronological, maximum);
};

const selectOfferedSlot = (message, offeredSlots, timeZone) => {
  const text = String(message || "").trim().toLowerCase();
  if (/\b(?:not|no|don't|do not|can't|cannot|cancel)\b/i.test(text)) return null;
  // Option numbers are whole selections, never digits embedded in a clock time.
  const option = text.match(/^(?:(?:option|number|the)\s+)?(first|second|third|one|two|three|1|2|3)(?:\s+(?:one|option))?(?:\s+(?:please|works(?: for me)?))?[.! ]*$/);
  if (option) {
    const index = { first: 0, one: 0, "1": 0, second: 1, two: 1, "2": 1, third: 2, three: 2, "3": 2 }[option[1]];
    return offeredSlots[index] || null;
  }
  // Accept the exact offered label with a small acknowledgement suffix.
  // Substring matching can select negated labels or the wrong clock time.
  const normalizeLabel = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.! ]+$/, "");
  const labelReply = normalizeLabel(text).replace(/\s+(?:works(?: for me)?|please)$/, "");
  const labels = offeredSlots.filter(slot => normalizeLabel(slot.label) && normalizeLabel(slot.label) === labelReply);
  if (labels.length) return labels.length === 1 ? labels[0] : null;
  const clock = parseTimePreference(text, timeZone);
  const minutes = clock?.exactMinutes;
  if (!Number.isFinite(minutes)) return null;
  const range = findDateRange(text, timeZone, new Date());
  const matches = offeredSlots.filter((slot) => {
    const date = new Date(slot.startAt);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(({type, value}) => [type, value]));
    const key = `${fields.year}-${fields.month}-${fields.day}`;
    return Number(fields.hour) * 60 + Number(fields.minute) === minutes &&
      (!range || (key >= range.startDate && key <= range.endDate));
  });
  return matches.length === 1 ? matches[0] : null;
};

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
  const postalCode = String(lead?.address || "").match(ZIP_PATTERN)?.[1] || "";
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
    if (!offeredSlots.length) {
      const expandedStart = range.startDate > today ? range.startDate : today;
      const expanded = await getAvailabilityTool({ business, leadId: lead?._id, conversationId: conversation?._id, serviceOfferingId: service.id,
        startDate: expandedStart, endDate: new Date(new Date(`${expandedStart}T12:00:00Z`).getTime() + 14 * 86_400_000).toISOString().slice(0, 10), postalCode });
      if (expanded?.supportedServiceArea !== false) offeredSlots = filterAutomatedSlots(expanded?.slots).slice(0, 3);
      if (offeredSlots.length) alternativeNote = 'That time is unavailable under the business scheduling rules. ';
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
        reply: `${alternativeNote}${pricingNote ? `${pricingNote} ` : ""}Current openings: ${options}. Which option works best? Not a confirmed appointment; business approval required.`,
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

const updateState = async (conversation, changes) => {
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
  Object.entries(changes).forEach(([key, value]) => {
    conversation.set(`bookingState.${key}`, value);
  });
  await conversation.save();
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
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

  static async handle(parameters) {
    const classification = classifySmsIntent(parameters);
    const outcome = await this.handleTurn(parameters);
    if (outcome.handled && outcome.result) {
      const existing = String(parameters.lead?.serviceNeeded || "").trim();
      const extracted = classification.entities.serviceNeeded;
      outcome.result.serviceNeeded = (existing && existing !== "Unknown" ? existing : extracted) || outcome.result.serviceNeeded;
      const ranks = { low: 0, medium: 1, high: 2, emergency: 3 };
      if ((ranks[classification.entities.urgency] ?? -1) > (ranks[outcome.result.urgency] ?? -1)) outcome.result.urgency = classification.entities.urgency;
    }
    return outcome;
  }

  static async handleTurn({
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
    if (conversation?.humanTakeover || ['closed', 'archived'].includes(conversation?.status)) return { handled: false };

    const control = await handleConversationControl({ business, lead, conversation, customerMessage, channel });
    if (control) return { handled: true, result: control };
    const serviceGuard = await guardServiceRequest({ business, lead, conversation, customerMessage, channel });
    if (serviceGuard) return { handled: true, result: serviceGuard };
    const schedulingReply = schedulingQuestionReply({ customerMessage: text, business, lead });
    if (schedulingReply) return { handled: true, result: fixedResult({ reply: schedulingReply, category: "availability_inquiry" }) };

    const questionReply = bookingQuestionReply({ customerMessage: text, conversation });
    if (questionReply) return { handled: true, result: fixedResult({ reply: questionReply, category: "appointment_status" }) };

    if (!enabled) {
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
          await updateState(conversation, { offeredSlots: [], selectedSlot: null, status: 'not_started', expiresAt: null });
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
          await updateState(conversation, {
            status: "human_takeover",
            selectedSlot: selected,
            availabilityInquiry: false,
            escalatedAt: new Date(),
            offeredSlots: [],
            expiresAt: null,
            lastError: "selected_slot_requires_manual_confirmation",
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

    if (
      smsIntent.intents.pricing &&
      !smsIntent.intents.availabilityInquiry
    ) {
      const approvedEstimate = await getApprovedServiceEstimate({ businessId: business._id, serviceNeeded: lead?.serviceNeeded, customerMessage: text });

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
        (smsIntent.intents.availabilityInquiry ||
          hasBookingAvailabilityHint(
            text,
            business.timezone || "America/New_York",
          )) &&
        String(lead?.serviceNeeded || "").trim() &&
        lead.serviceNeeded !== "Unknown"
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
            reply: smsIntent.entities.serviceNeeded || (lead?.serviceNeeded && lead.serviceNeeded !== "Unknown")
            ? `I understand the reported issue, but need to match it to a bookable service.${choices} ${matches.length ? "Which listed service should I check first?" : "What type of equipment or fixture needs service?"}`
            : `What service would you like to schedule?${choices}`,
          }),
        };
      }

      const selectedService = matches[0];
      await updateState(activeConversation, {
        status: "collecting_location",
        serviceOffering: selectedService.id,
        streetAddress: "",
        postalCode: "",
        availabilityInquiry: smsIntent.intents.availabilityInquiry,
      });

      const compoundPricingNote = await buildAvailabilityPricingNote({
        business,
        bookingState: activeConversation.bookingState,
        lead,
        text,
      });

      if (lead && (!lead.serviceNeeded || lead.serviceNeeded === "Unknown")) {
        lead.serviceNeeded = smsIntent.entities.serviceNeeded || selectedService.name;
        await lead.save();
      }

      return {
        handled: true,
        result: fixedResult({
          reply: `${compoundPricingNote ? `${compoundPricingNote} ` : ""}I can check times for ${selectedService.name}. I need the address and ZIP code in two steps. First, what is the street address for the service visit?`,
        }),
      };
    }

    if (
      status === "collecting_street_address" ||
      status === "collecting_location"
    ) {
      const { street, valid } = parseStreetAddress(text);
      const suppliedZip =
        normalizeSpokenAddress(text).match(ZIP_PATTERN)?.[1] ||
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

      if (activeConversation.bookingState?.availabilityInquiry) {
        return this.handle({
          business,
          lead,
          conversation: activeConversation,
          customerMessage: "earliest availability",
          channel: bookingChannel,
          source: bookingSource,
        });
      }

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

      if (activeConversation.bookingState?.availabilityInquiry) {
        return this.handle({
          business,
          lead,
          conversation: activeConversation,
          customerMessage: "earliest availability",
          channel: bookingChannel,
          source: bookingSource,
        });
      }

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

      await updateState(activeConversation, { searchStartDate: range.startDate, searchEndDate: range.endDate });

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
        lastCustomerPreference: availabilityInquiry
          ? activeConversation.bookingState?.lastCustomerPreference || ""
          : text,
        lastAvailabilityCheckedAt: new Date(),
        availabilityInquiry: false,
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
          reply: `${compoundPricingNote ? `${compoundPricingNote} ` : ""}I have ${options}. Which option works best?`,
        }),
      };
    }

    if (status === "offering_slots") {
      const slot = selectOfferedSlot(
        text,
        filterAutomatedSlots(activeConversation.bookingState.offeredSlots || []),
        business.timezone || "America/New_York",
      );

      if (!slot) {
        if (smsIntent.intents.availabilityInquiry || hasAppointmentPreferenceHint(text, business.timezone || "America/New_York")) {
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
          reply: `You selected ${formatSlot(
            slot,
            business.timezone || "America/New_York",
          )} for ${serviceName} at ${address}. Would you like me to submit this appointment request for business approval? It is not confirmed yet. Reply YES to submit it.`,
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
              "Please reply YES to submit that exact time for business approval, or NO to choose another day.",
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
          estimatedValue: lead?.estimatedValue ?? null,
          source: bookingChannel,
          bookedBy: "ai",
          urgency: lead?.urgency || "medium",
        };
        const isReschedule =
          activeConversation.bookingState.lastError ===
            "reschedule_requested" &&
          activeConversation.bookingState.appointment;
        assertVoiceTurnActive();
        if (isReschedule) {
          const requestedTime = formatSlot(
            selectedSlot,
            business.timezone || "America/New_York",
          );
          await AlertService.createSystemAlert({
            businessId: business._id,
            title: "Appointment reschedule approval required",
            message:
              "The customer selected a replacement time. The existing confirmed appointment remains in place until the business approves and performs the reschedule.",
            priority: ["high", "emergency"].includes(String(lead?.urgency || ""))
              ? "high"
              : "medium",
            metadata: {
              appointmentId: String(
                activeConversation.bookingState.appointment,
              ),
              leadId: lead?._id ? String(lead._id) : "",
              conversationId: String(activeConversation._id),
              requestedStartAt: selectedSlot.startAt,
              requestedEndAt: selectedSlot.endAt,
              channel: bookingChannel,
            },
            dedupeKey: `ai_reschedule_approval:${activeConversation.bookingState.appointment}:${new Date(selectedSlot.startAt).toISOString()}`,
          });

          await updateState(activeConversation, {
            status: "booked",
            selectedSlot: null,
            offeredSlots: [],
            expiresAt: null,
            lastError: "reschedule_pending_business_approval",
          });

          return {
            handled: true,
            result: fixedResult({
              reply: `I’ve submitted your request to move the appointment to ${requestedTime}. Your existing appointment remains confirmed until the business approves the change.`,
            }),
          };
        }

        const appointment = await createAppointmentTool({
          business,
          idempotencyKey: `${bookingIdempotencyPrefix}ai-book:${activeConversation._id}:${new Date(
            selectedSlot.startAt,
          ).toISOString()}`,
          input: bookingInput,
        });

        assertVoiceTurnActive();
        if (
          appointment.status !== "held" ||
          appointment.requiresBusinessApproval !== true
        ) {
          const invariantError = new Error(
            "AI appointment creation bypassed the required business-approval hold.",
          );
          invariantError.code = "AI_BOOKING_APPROVAL_INVARIANT_VIOLATION";
          invariantError.safeCustomerMessage =
            "I couldn’t safely submit that appointment request. I’ve alerted the team so they can confirm a time directly.";
          throw invariantError;
        }

        await updateState(activeConversation, {
          status: "pending_business_confirmation",
          appointment: appointment._id,
          expiresAt: appointment.heldExpiresAt || null,
          lastError: "",
        });

        return {
          handled: true,
          result: fixedResult({
            reply: `I’ve submitted ${formatSlot(
              appointment,
              appointment.timezone,
            )} for ${lead?.serviceNeeded || "your service request"} pending business approval. The appointment is not confirmed until the team accepts it.`,
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
              "Your requested appointment is still awaiting business approval. It is not confirmed yet. I can’t guarantee a confirmation call or a response time.",
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
