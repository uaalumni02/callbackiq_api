// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1: policy
import { classifySmsIntent } from "./smsIntentClassifier.service.js";
import {
  findDateRange,
  hasAppointmentPreferenceHint,
  parseTimePreference,
} from "../booking/appointmentPreferenceParser.service.js";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

const PRICING_PATTERNS = [
  /\bhow much\b/i,
  /\b(?:price|pricing|cost|quote|estimate|service call fee|diagnostic fee)\b/i,
  /\bwhat (?:will|would|does|do) (?:it|this|that|you) cost\b/i,
];

const HUMAN_PATTERNS = [
  /\b(?:human|representative|agent|manager|owner|staff member)\b/i,
  /\b(?:talk|speak|connect|transfer)\s+(?:me\s+)?(?:to|with)\s+(?:a\s+)?(?:person|someone|human|representative|agent|manager|owner|staff member)\b/i,
  /\b(?:call me|have someone call me|can a person call me)\b/i,
];

const STATUS_PATTERNS = [
  /\b(?:where is|where's|status|eta|on the way|coming|arriving|still coming)\b/i,
];

const CANCEL_PATTERNS = [
  /\b(?:cancel|cancellation|don't come|do not come|no longer need|never mind|nevermind)\b/i,
];

const RESCHEDULE_PATTERNS = [
  /\b(?:reschedule|change (?:my|the) appointment|different time|different day|move (?:it|the appointment))\b/i,
];

const SERVICE_PATTERNS = [
  /\b(?:i have|i've got|we have|we've got|need help with|help with|problem is|issue is)\s+(.{3,120})$/i,
];

const ACTIVE_URGENCY =
  /\b(?:overflow(?:ing)?|flood(?:ing|ed)?|burst|gushing|won't stop|will not stop|no heat|no ac|no a\/c|no power|sparking|smoke|burning|gas smell|sewage|completely blocked|unusable|locked out)\b/i;

const GENERIC_SCHEDULING_REPLY =
  /\b(?:reply|send|share|provide).{0,35}\b(?:day|days).{0,25}\b(?:time|times)\b|\bwhat day and time\b|\bwhen works best\b/i;

const ACKNOWLEDGED_PREFERENCE_REPLY =
  /\b(?:noted|got|have).{0,35}\b(?:preferred|preference|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|time)\b/i;

const normalizeExtractedService = (value) => {
  const service = clean(value)
    .replace(/[?.!]+$/, "")
    .replace(
      /\s+(?:and|but)\s+(?:can|could|will|would|are|is|do)\s+you\b[\s\S]*$/i,
      "",
    )
    .trim();

  if (!service || service.length < 3 || service.length > 100) return "";
  if (PRICING_PATTERNS.some((pattern) => pattern.test(service))) return "";
  return service;
};

export const extractServiceNeed = (message) => {
  const text = clean(message);

  for (const pattern of SERVICE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeExtractedService(match[1]);
  }

  const possessive = text.match(
    /\b(?:my|our)\s+([a-z][a-z0-9 '-]{1,50})\s+(?:is|are)\s+([a-z][a-z0-9 '-]{1,70})(?:[.!?]|$)/i,
  );

  if (possessive) {
    return normalizeExtractedService(
      `${possessive[1]} is ${possessive[2]}`,
    );
  }

  return "";
};

const hasPricingIntent = (text) =>
  PRICING_PATTERNS.some((pattern) => pattern.test(text));
const hasHumanIntent = (text) =>
  HUMAN_PATTERNS.some((pattern) => pattern.test(text));
const hasStatusIntent = (text) =>
  STATUS_PATTERNS.some((pattern) => pattern.test(text));
const hasCancelIntent = (text) =>
  CANCEL_PATTERNS.some((pattern) => pattern.test(text));
const hasRescheduleIntent = (text) =>
  RESCHEDULE_PATTERNS.some((pattern) => pattern.test(text));

const fixedResult = ({
  reply,
  category,
  preferredAppointmentTime = "",
  serviceNeeded = "",
  urgency = "medium",
  shouldAlertOwner = false,
  alertPriority = "low",
  summary = "",
}) => ({
  decision: "send_fixed_response",
  actionType: "send_fixed_response",
  messageCategory: category,
  reply,
  serviceNeeded,
  urgency,
  address: "",
  preferredAppointmentTime,
  leadQualityScore: 0,
  estimatedValue: 0,
  summary: summary || `Deterministic SMS turn policy handled ${category}.`,
  shouldAlertOwner,
  alertPriority,
  alertTitle: shouldAlertOwner ? "Customer needs attention" : "",
  alertMessage: shouldAlertOwner
    ? "Review the latest customer SMS and follow up."
    : "",
  riskFlags: [],
  confidence: 100,
  guardrail: {
    skipAI: true,
    reason: "sms_turn_policy",
    usedFallback: false,
    violations: [],
  },
});

const getBusinessName = (business) =>
  clean(business?.businessName || "the business");

const isAutoBookingEnabled = (business) =>
  Boolean(business?.features?.aiBookingEnabled);

const formatClock = (minutes) => {
  if (!Number.isFinite(minutes)) return "";
  const hour24 = Math.floor(minutes / 60) % 24;
  const minute = Math.floor(minutes % 60);
  const meridiem = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
};

const formatDateKey = (dateKey) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) {
    return "";
  }

  const [year, month, day] = String(dateKey).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
};

const buildPreferenceLabel = ({ text, range, timePreference }) => {
  const sameDay =
    range?.startDate &&
    range?.endDate &&
    range.startDate === range.endDate;

  const dateLabel = sameDay ? formatDateKey(range.startDate) : "";
  const target = timePreference?.targetMinutes;
  const exact = timePreference?.exactMinutes;
  const windowStart = timePreference?.windowStartMinutes;
  const windowEnd = timePreference?.windowEndMinutes;
  const dayPart = clean(timePreference?.timeOfDay);

  let timeLabel = "";

  if (
    Number.isFinite(target) &&
    Number.isFinite(windowStart) &&
    windowStart === target &&
    windowEnd === 24 * 60
  ) {
    timeLabel = `after ${formatClock(target)}`;
  } else if (
    Number.isFinite(target) &&
    windowStart === 0 &&
    windowEnd === target
  ) {
    timeLabel = `before ${formatClock(target)}`;
  } else if (Number.isFinite(exact)) {
    timeLabel = `at ${formatClock(exact)}`;
  } else if (Number.isFinite(target)) {
    timeLabel = `around ${formatClock(target)}`;
  } else if (dayPart) {
    timeLabel = dayPart;
  }

  if (dateLabel && timeLabel) return `${dateLabel} ${timeLabel}`;
  if (dateLabel) return dateLabel;
  if (timeLabel) return timeLabel;

  return clean(text)
    .replace(
      /\b(?:are you available|is anyone available|can you come|could you come|will you come|does that work|works for me|for the service|for service)\b/gi,
      "",
    )
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
};

const safePreferenceAcknowledgement = ({
  business,
  preferenceLabel,
  serviceNeeded = "",
}) => {
  const service = clean(serviceNeeded);
  const servicePhrase = service ? ` for ${service}` : "";
  return `I've noted ${preferenceLabel}${servicePhrase} as your preferred time. This is a request, not a confirmed appointment. ${getBusinessName(
    business,
  )} will confirm availability as soon as possible.`;
};

const pricingAndSchedulingReply = ({
  business,
  preferenceLabel,
  serviceNeeded = "",
}) => {
  const service = clean(serviceNeeded);
  const servicePhrase = service ? ` for ${service}` : "";
  return `Final pricing depends on the diagnosis, so ${getBusinessName(
    business,
  )} will confirm the cost. I've also noted ${preferenceLabel}${servicePhrase} as your preferred time. This is a request, not a confirmed appointment. The team will confirm availability directly.`;
};

const pricingReply = ({ lead, business }) => {
  const service = clean(lead?.serviceNeeded);

  if (!service || service === "Unknown") {
    return `The exact cost depends on the issue, so ${getBusinessName(
      business,
    )} will confirm pricing after assessing it. What service do you need help with?`;
  }

  const urgency = clean(lead?.urgency).toLowerCase();

  if (!urgency || urgency === "medium") {
    return `The exact cost depends on what is causing the issue, so ${getBusinessName(
      business,
    )} will confirm pricing after assessment. Is it causing an active leak, overflow, loss of service, or safety concern?`;
  }

  if (!clean(lead?.address)) {
    return `The exact cost depends on the diagnosis, so ${getBusinessName(
      business,
    )} will confirm pricing before work begins. What is the service address?`;
  }

  return `The exact cost depends on the diagnosis, so ${getBusinessName(
    business,
  )} will confirm pricing before work begins. I've kept the details you've already provided.`;
};

export const evaluateSmsTurnPolicy = ({
  customerMessage,
  business,
  lead = {},
  conversation = null,
  now = new Date(),
}) => {
  const text = clean(customerMessage);
  const timeZone = business?.timezone || "America/New_York";
  const serviceNeeded = extractServiceNeed(text);
  const range = findDateRange(text, timeZone, now);
  const timePreference = parseTimePreference(text, timeZone);
  const appointmentHint =
    hasAppointmentPreferenceHint(text, timeZone) ||
    Boolean(range) ||
    timePreference?.targetMinutes !== null ||
    Boolean(timePreference?.timeOfDay);

  const canonical = classifySmsIntent({
    customerMessage: text,
    business,
    conversation,
    now,
  });
  const intent = {
    pricing: canonical.intents.pricing,
    human: canonical.intents.human,
    status: canonical.intents.status,
    cancel: canonical.intents.cancel,
    reschedule: canonical.intents.reschedule,
    scheduling: canonical.intents.scheduling,
    service: Boolean(serviceNeeded || canonical.entities.serviceNeeded),
    urgent: ACTIVE_URGENCY.test(text),
    correction: canonical.intents.correction,
    newService: canonical.intents.newService,
    callback: canonical.intents.callback,
  };

  const existingService =
    clean(lead?.serviceNeeded) &&
    clean(lead?.serviceNeeded) !== "Unknown"
      ? clean(lead?.serviceNeeded)
      : "";

  const explicitServiceCorrection =
    /\b(?:actually|instead|rather|different issue|correction|not .{0,30}(?:but|it's|it is))\b/i.test(
      text,
    );

  /*
   * A scheduling turn can paraphrase the already-known service ("my toilet
   * is clogged") without meaning the canonical lead service changed. Preserve
   * the known lead service unless the customer explicitly corrects it.
   */
  const knownService =
    explicitServiceCorrection && serviceNeeded
      ? serviceNeeded
      : existingService || serviceNeeded;

  const preferenceLabel = buildPreferenceLabel({
    text,
    range,
    timePreference,
  });

  let directResult = null;
  const autoBookingEnabled = isAutoBookingEnabled(business);

  /*
   * When auto-booking is enabled, the booking state machine remains the
   * authority for scheduling, human requests, appointment changes, and
   * exact-price questions that occur during booking.
   */
  if (!autoBookingEnabled && intent.human) {
    directResult = fixedResult({
      reply: `Absolutely. I've asked ${getBusinessName(
        business,
      )} to call you at the number you're texting from. A team member will follow up as soon as possible.`,
      category: "human_requested",
      shouldAlertOwner: true,
      alertPriority: "high",
    });
  } else if (
    !autoBookingEnabled &&
    (intent.status || intent.cancel || intent.reschedule)
  ) {
    const action = intent.cancel
      ? "cancel"
      : intent.reschedule
        ? "change"
        : "check";

    directResult = fixedResult({
      reply: `I've sent your request to ${getBusinessName(
        business,
      )} to ${action} the appointment details. The team will confirm the update directly.`,
      category: intent.cancel
        ? "appointment_cancellation"
        : intent.reschedule
          ? "appointment_reschedule"
          : "appointment_status",
      shouldAlertOwner: true,
      alertPriority: "high",
    });
  } else if (
    !autoBookingEnabled &&
    appointmentHint &&
    intent.pricing
  ) {
    directResult = fixedResult({
      reply: pricingAndSchedulingReply({
        business,
        preferenceLabel,
        serviceNeeded: knownService,
      }),
      category: "appointment_preference",
      preferredAppointmentTime: text,
      serviceNeeded: knownService,
      urgency: intent.urgent ? "high" : clean(lead?.urgency) || "medium",
    });
  } else if (!autoBookingEnabled && appointmentHint) {
    directResult = fixedResult({
      reply: safePreferenceAcknowledgement({
        business,
        preferenceLabel,
        serviceNeeded: knownService,
      }),
      category: "appointment_preference",
      preferredAppointmentTime: text,
      serviceNeeded: knownService,
      urgency: intent.urgent ? "high" : clean(lead?.urgency) || "medium",
    });
  } else if (!autoBookingEnabled && intent.pricing) {
    directResult = fixedResult({
      reply: pricingReply({ lead, business }),
      category: "pricing_request",
      serviceNeeded: knownService,
      urgency: intent.urgent ? "high" : clean(lead?.urgency) || "medium",
    });
  }

  return {
    text,
    timeZone,
    serviceNeeded,
    range,
    timePreference,
    appointmentHint,
    preferenceLabel,
    intent,
    directResult,
    bookingStatus: clean(conversation?.bookingState?.status),
  };
};

const triageQuestion = ({ service }) =>
  `I can help${service ? ` with ${service}` : ""}. Is this causing an active leak, overflow, loss of service, or another urgent safety issue?`;

export const applySmsTurnPolicy = ({
  result,
  policy,
  business,
  lead = {},
}) => {
  if (!result || !policy) return result;

  const next = {
    ...result,
    serviceNeeded:
      clean(result.serviceNeeded) ||
      policy.serviceNeeded ||
      clean(lead?.serviceNeeded),
    preferredAppointmentTime:
      clean(result.preferredAppointmentTime) ||
      (policy.intent.scheduling
        ? policy.text
        : clean(lead?.preferredAppointmentTime)),
  };

  const reply = clean(next.reply);

  /*
   * Core regression guard: a customer who supplied a day/time must never
   * receive a reply asking them to supply a day/time.
   */
  if (
    policy.intent.scheduling &&
    GENERIC_SCHEDULING_REPLY.test(reply)
  ) {
    next.reply = safePreferenceAcknowledgement({
      business,
      preferenceLabel:
        policy.preferenceLabel ||
        buildPreferenceLabel({
          text: policy.text,
          range: policy.range,
          timePreference: policy.timePreference,
        }),
      serviceNeeded:
        policy.serviceNeeded || clean(lead?.serviceNeeded),
    });
    next.messageCategory = "appointment_preference";
    next.preferredAppointmentTime = policy.text;
    next.decision = "send_fixed_response";
    next.actionType = "send_fixed_response";
    next.guardrail = {
      ...(next.guardrail || {}),
      reason: "sms_turn_policy_prevented_reask",
      usedFallback: false,
    };
  }

  /*
   * A service/problem statement is not implicit permission to skip directly
   * to scheduling. Capture the service and gather one useful operational fact.
   */
  if (
    policy.intent.service &&
    !policy.intent.scheduling &&
    !policy.intent.pricing &&
    GENERIC_SCHEDULING_REPLY.test(reply)
  ) {
    next.reply = triageQuestion({ service: policy.serviceNeeded });
    next.messageCategory = "service_request";
    next.serviceNeeded = policy.serviceNeeded;
    next.decision = "send_fixed_response";
    next.actionType = "send_fixed_response";
    next.guardrail = {
      ...(next.guardrail || {}),
      reason: "sms_turn_policy_service_context",
      usedFallback: false,
    };
  }

  if (
    policy.intent.scheduling &&
    ACKNOWLEDGED_PREFERENCE_REPLY.test(clean(next.reply))
  ) {
    next.preferredAppointmentTime = policy.text;
  }

  return next;
};

export default {
  evaluateSmsTurnPolicy,
  applySmsTurnPolicy,
  extractServiceNeed,
};
