// CALLBACKIQ_SMS_PRODUCTION_INVARIANT_V1
// Final customer-facing SMS safety layer. This does not replace the canonical
// classifier, intake state machine, service-eligibility policy, or booking
// state machine. It enforces cross-cutting production invariants immediately
// before a reply can be persisted/sent and is intentionally idempotent.

import { sanitizeUnverifiedStaffCommitments } from "../customerCommitmentSafety.service.js";
import {
  evaluateSmsTurnPolicy,
  safePreferenceAcknowledgement,
} from "./smsTurnPolicy.service.js";

const clean = (value) =>
  String(value || "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const lower = (value) => clean(value).toLowerCase();
const known = (value) => {
  const text = clean(value);
  return Boolean(text && !/^(?:unknown|n\/?a|none|null|undefined)$/i.test(text));
};

const SERVICE_REASK = /(?:^|[.!?]\s*)(?:what|which)\s+(?:service|work|repair)\b[^?]{0,100}\?|(?:^|[.!?]\s*)what do you need help with\??/gi;
const ADDRESS_REASK = /(?:^|[.!?]\s*)(?:what(?:'s| is)\s+(?:the\s+)?(?:service\s+)?address|where is the service(?: located)?|what address should (?:we|the business) use)\??/gi;
const TIME_REASK = /(?:^|[.!?]\s*)(?:what\s+(?:day|date|time)(?:\s+and\s+time)?\b[^?]{0,100}\?|when (?:would|do) you (?:prefer|want)[^?]{0,100}\?|what days? and times? work[^?]{0,100}\?|when works best[^?]{0,100}\?)/gi;

const PRICE_LANGUAGE = /\b(?:price|pricing|cost|quote|estimate|diagnostic fee|service call fee|\$\s*\d)/i;
const SCHEDULING_ACK = /\b(?:preferred time|preference|requested time|request, not a confirmed appointment|not confirmed|availability still needs|noted .{0,40}(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|time|date))\b/i;
const CALLBACK_LANGUAGE = /\b(?:call|callback|phone)\b/i;
const SCHEDULING_OR_QUOTE = /\b(?:book|booking|schedule|appointment|availability|available|day|date|time|price|pricing|cost|quote|estimate)\b/i;

const STRONG_BOOKING_SENTENCES = [
  /\b(?:you(?:'re| are)|we(?:'ve| have)(?: got you)?|i(?:'ve| have)(?: got you)?)\s+(?:booked|scheduled|confirmed)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:your|the)\s+(?:appointment|visit|service call)\s+(?:is|has been)\s+(?:booked|scheduled|confirmed)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:we|a technician|the technician|someone|our team)\s+(?:will|can)\s+(?:be there|arrive|come out|come by)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:we|our team|the technician)\s+(?:will|'ll)\s+(?:see you|meet you)\b[^.!?]*(?:[.!?]|$)/gi,
];

const isConfirmedBooking = (conversation) => {
  const booking = conversation?.bookingState || {};
  const appointment = booking?.appointment || {};
  const statuses = [booking?.status, appointment?.status, appointment?.approvalStatus]
    .map(lower)
    .filter(Boolean);
  return (
    appointment?.confirmed === true ||
    appointment?.approved === true ||
    statuses.some((status) => ["confirmed", "approved", "booked", "scheduled"].includes(status))
  );
};

const safeUnconfirmedBookingStatement = ({ lead = {} } = {}) => {
  const pref = clean(lead?.preferredAppointmentTime);
  if (pref) {
    return `I have ${pref} as the requested time. The appointment is not confirmed yet.`;
  }
  return "I have the service request, but the appointment is not confirmed yet.";
};

export const sanitizeUnverifiedBookingCommitments = (
  value,
  { conversation = null, lead = {} } = {},
) => {
  let text = clean(value);
  if (!text || isConfirmedBooking(conversation)) return text;

  let replaced = false;
  for (const pattern of STRONG_BOOKING_SENTENCES) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => {
      replaced = true;
      return " ";
    });
  }

  text = clean(text);
  if (!replaced) return text;
  const safe = safeUnconfirmedBookingStatement({ lead });
  return clean(`${text} ${safe}`);
};

const removeKnownFactReasks = ({ reply, lead = {}, policy = null }) => {
  let text = clean(reply);
  const serviceKnown = known(lead?.serviceNeeded);
  const addressKnown = known(lead?.address);
  const preferenceKnown = known(lead?.preferredAppointmentTime) ||
    Boolean(policy?.appointmentHint && !policy?.intent?.availabilityInquiry);

  let removedService = false;
  let removedAddress = false;
  let removedTime = false;

  if (serviceKnown && SERVICE_REASK.test(text)) {
    SERVICE_REASK.lastIndex = 0;
    text = text.replace(SERVICE_REASK, " ");
    removedService = true;
  }
  SERVICE_REASK.lastIndex = 0;

  if (addressKnown && ADDRESS_REASK.test(text)) {
    ADDRESS_REASK.lastIndex = 0;
    text = text.replace(ADDRESS_REASK, " ");
    removedAddress = true;
  }
  ADDRESS_REASK.lastIndex = 0;

  if (preferenceKnown && TIME_REASK.test(text)) {
    TIME_REASK.lastIndex = 0;
    text = text.replace(TIME_REASK, " ");
    removedTime = true;
  }
  TIME_REASK.lastIndex = 0;

  text = clean(text);
  if (!(removedService || removedAddress || removedTime)) {
    return { reply: text, actions: [] };
  }

  const actions = [];
  if (removedService) actions.push("removed_known_service_reask");
  if (removedAddress) actions.push("removed_known_address_reask");
  if (removedTime) actions.push("removed_known_time_reask");

  if (text) return { reply: text, actions };

  if (!addressKnown) {
    return {
      reply: "I already have the service request. What is the service address?",
      actions,
    };
  }
  if (!preferenceKnown) {
    return {
      reply: "I already have the service request and address. What day or time would you prefer?",
      actions,
    };
  }

  if (policy?.appointmentHint && !policy?.intent?.availabilityInquiry) {
    return {
      reply: safePreferenceAcknowledgement({
        business: null,
        preferenceLabel: policy?.preferenceLabel || clean(lead?.preferredAppointmentTime) || "that time",
        serviceNeeded: clean(lead?.serviceNeeded),
      }),
      actions,
    };
  }

  return {
    reply: "I already have those details and will keep using the information you provided. The appointment is not confirmed yet.",
    actions,
  };
};

const serviceEligibilityState = ({ result, lead, conversation }) =>
  result?.serviceEligibility || conversation?.serviceEligibility || lead?.serviceEligibility || null;

const enforceEligibilityBoundary = ({ result, reply, lead, conversation }) => {
  const state = serviceEligibilityState({ result, lead, conversation });
  const decision = lower(state?.decision);
  if (!decision || decision === "supported") return { reply, changed: false };

  if (decision === "unsupported") {
    return {
      changed: true,
      reply:
        "That request is not a service this business has confirmed it accepts. I won't quote it or collect appointment details for that work. If you have a different service request, tell me what you need help with.",
    };
  }

  if (decision === "needs_clarification") {
    if (!SCHEDULING_OR_QUOTE.test(reply)) return { reply, changed: false };
    return {
      changed: true,
      reply:
        "I need to clarify the requested service before pricing or scheduling. What specifically needs to be repaired, replaced, or inspected?",
    };
  }

  if (decision === "needs_staff_review") {
    const schedulingOrPricingResult = /(?:appointment|availability|pricing|quote|estimate)/i.test(
      clean(result?.messageCategory),
    );
    const asksForTime = TIME_REASK.test(reply);
    TIME_REASK.lastIndex = 0;
    if (!schedulingOrPricingResult && !asksForTime) return { reply, changed: false };
    return {
      changed: true,
      reply:
        "This service request needs staff review before pricing or scheduling can continue. No appointment is confirmed yet.",
    };
  }

  return { reply, changed: false };
};

const dedupeSafetySentences = (value) => {
  const parts = clean(value).match(/[^.!?]+[.!?]?/g) || [];
  const seen = new Set();
  let kept911 = false;
  const output = [];

  for (const part of parts) {
    const sentence = clean(part);
    if (!sentence) continue;
    const normalized = lower(sentence).replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    if (/\b911\b/.test(sentence)) {
      if (kept911) continue;
      kept911 = true;
    }
    output.push(sentence);
  }

  return clean(output.join(" "));
};

const ensureMultiIntentCoverage = ({ reply, policy, lead, business }) => {
  let text = clean(reply);
  const actions = [];
  if (!policy) return { reply: text, actions };

  if (policy?.intent?.pricing && !PRICE_LANGUAGE.test(text)) {
    text = clean(`I don't have a confirmed price yet. ${text}`);
    actions.push("added_pricing_answer");
  }

  if (policy?.intent?.scheduling && policy?.appointmentHint) {
    if (
      policy?.intent?.availabilityInquiry &&
      !/\b(?:availability|available|unavailable|openings?|slots?|needs? to be checked)\b/i.test(text)
    ) {
      const label = policy?.preferenceLabel || clean(lead?.preferredAppointmentTime) || "that time";
      text = clean(
        `${text} I can't confirm availability for ${label} from this reply; that time still needs to be checked.`,
      );
      actions.push("added_availability_answer");
    } else if (!policy?.intent?.availabilityInquiry && !SCHEDULING_ACK.test(text) && !/\b(?:no eligible openings|not available|isn.t available|couldn.t verify|currently available)\b/i.test(text)) {
      text = clean(`${text} ${safePreferenceAcknowledgement({
        business,
        preferenceLabel: policy?.preferenceLabel || clean(lead?.preferredAppointmentTime) || "that time",
        serviceNeeded: clean(lead?.serviceNeeded || policy?.serviceNeeded),
      })}`);
      actions.push("added_scheduling_acknowledgement");
    }
  }

  if (policy?.intent?.callback && !CALLBACK_LANGUAGE.test(text)) {
    text = clean(
      `${text} You also asked for a call. I can't guarantee when someone will be available; I can keep helping by text.`,
    );
    actions.push("added_callback_acknowledgement");
  }

  return { reply: text, actions };
};

export const applySmsProductionInvariants = ({
  result = {},
  business = {},
  lead = {},
  conversation = null,
  customerMessage = "",
  now = new Date(),
} = {}) => {
  if (!result || result?.decision === "no_reply") return result;

  const next = { ...result };
  const actions = [];
  let reply = clean(next.reply);

  let policy = null;
  try {
    policy = evaluateSmsTurnPolicy({
      customerMessage,
      business,
      lead,
      conversation,
      now,
    });
  } catch {
    // This layer must never make the send path less reliable. If canonical
    // policy evaluation is unavailable, commitment and eligibility guards
    // still apply without multi-intent enrichment.
  }

  const contactControl = next.guardrail?.reason === "sms_contact_control" && Boolean(next.contactControl);
  const eligibility = contactControl ? { reply, changed: false } : enforceEligibilityBoundary({
    result: next,
    reply,
    lead,
    conversation,
  });
  if (eligibility.changed) actions.push("enforced_service_eligibility_boundary");
  reply = eligibility.reply;

  const sanitizedStaff = sanitizeUnverifiedStaffCommitments(reply, { channel: "sms" });
  if (sanitizedStaff !== reply) actions.push("removed_unverified_staff_commitment");
  reply = sanitizedStaff;

  const sanitizedBooking = sanitizeUnverifiedBookingCommitments(reply, {
    conversation,
    lead,
  });
  if (sanitizedBooking !== reply) actions.push("removed_unverified_booking_commitment");
  reply = sanitizedBooking;

  // The shared intake decision already answered scheduling and selected the
  // missing field. Rewriting it can remove a legitimate alternative-date question
  // or contradict a completed calendar check. Keep commitment/eligibility guards.
  const authoritativeIntake = contactControl || next.compoundTurn === true || next.guardrail?.reason === "shared_recovery_intake" ||
    (next.guardrail?.reason === "sms_handoff_acknowledgement" && Boolean(next.intakeReview));
  const knownFact = authoritativeIntake ? { reply, actions: [] } : removeKnownFactReasks({ reply, lead, policy });
  reply = knownFact.reply;
  actions.push(...knownFact.actions);

  const eligibilityDecision = lower(
    serviceEligibilityState({ result: next, lead, conversation })?.decision,
  );
  if (!authoritativeIntake && (!eligibilityDecision || eligibilityDecision === "supported")) {
    const multiIntent = ensureMultiIntentCoverage({
      reply,
      policy,
      lead,
      business,
    });
    reply = multiIntent.reply;
    actions.push(...multiIntent.actions);
  }

  const deduped = dedupeSafetySentences(reply);
  if (deduped !== reply) actions.push("deduped_repeated_safety_language");
  reply = deduped;

  if (!reply && next?.decision !== "no_reply") {
    reply =
      "I don't want to guess about your request. Please give me one more detail about what you need, and I'll keep the information already provided.";
    actions.push("added_safe_ambiguity_fallback");
  }

  next.reply = clean(reply);
  next.guardrail = {
    ...(next.guardrail || {}),
    productionInvariantApplied: true,
    productionInvariantActions: [...new Set(actions)],
  };

  return next;
};

export default {
  applySmsProductionInvariants,
  sanitizeUnverifiedBookingCommitments,
};
