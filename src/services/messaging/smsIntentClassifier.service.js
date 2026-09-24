import { requestQuestions } from '../booking/requestQuestionPolicy.service.js';
import {
  findDateRange,
  hasAppointmentPreferenceHint,
  parseTimePreference,
} from "../booking/appointmentPreferenceParser.service.js";
import {
  classifyOperationalUrgency,
  isAvailabilityInquiryText,
  isWaitlistInquiryText,
  isEmergencyAvailabilityText,
} from "../scheduling/customerSchedulingIntent.service.js";

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const any = (patterns, text) => patterns.some((pattern) => pattern.test(text));

const PRICING = [
  /\bhow much\b/i,
  /\b(?:price|pricing|cost|quote|estimate|service call fee|diagnostic fee)\b/i,
  /\bwhat (?:will|would|does|do) (?:it|this|that|you) cost\b/i,
];

const HUMAN = [
  /\b(?:real\s+person|human|representative|live\s+agent|manager|owner|staff member)\b/i,
  /\b(?:talk|speak|connect|transfer)\s+(?:me\s+)?(?:to|with)\s+(?:a\s+)?(?:person|human|representative|agent|manager|owner|staff member)\b/i,
  /\b(?:call me|have (?:a )?(?:person|someone|the team) call me|can (?:a )?(?:person|someone) call me)\b/i,
  /\b(?:not a bot|stop texting me (?:a )?(?:bot|robot)|get me (?:a )?(?:person|human))\b/i,
];

const CALLBACK = [
  /\b(?:call me|give me a call|can you call|have (?:the team|someone|a person) call)\b/i,
];

const STATUS = [
  /\b(?:where is|where's)\s+(?:(?:my|the)\s+)?(?:tech|technician|crew|appointment)\b/i,
  /\b(?:appointment|tech|technician|crew)\s+(?:status|eta)\b/i,
  /\b(?:is|are)\s+(?:the\s+)?(?:tech|technician|crew)\s+(?:on the way|coming|still coming|arriving)\b/i,
  /\b(?:on the way|arrival window|eta)\b/i,
];

const CANCEL = [
  /\b(?:cancel|cancellation)\s+(?:my\s+|the\s+)?(?:appointment|visit|booking)\b/i,
  /\b(?:don't|do not)\s+come\b/i,
  /\bno longer need (?:the )?(?:appointment|visit|service)\b/i,
];

const RESCHEDULE = [
  /\b(?:reschedule|move)\s+(?:my\s+|the\s+)?(?:appointment|visit|booking)\b/i,
  /\bchange\s+(?:my\s+|the\s+)?(?:appointment|time|day)\b/i,
  /\b(?:different|another)\s+(?:appointment\s+)?(?:time|day)\b/i,
];

const CORRECTION = [
  /\b(?:it['’]?s|it is)\b.{0,60}\bnot\b|\bnot\b.{1,50},/i,
  /\b(?:actually|correction|instead|rather|i meant|make that|not .{0,35}(?:but|it's|it is))\b/i,
];

const NEW_SERVICE = [
  /\b(?:different issue|another issue|new issue|something else|also have|one more thing)\b/i,
];

/*
 * Availability questions are not appointment preferences. Detection is shared
 * with Voice so the same customer wording always reaches the calendar.
 */

// CALLBACKIQ_BOOKING_RECOVERY_FIX_V2: compound turns keep urgency independent from booking intent.
const extractUrgency = (text) => classifyOperationalUrgency(text);

const BOOKING_REQUEST = /\b(?:book|booking|schedule|scheduling|appointment|availability|available|set up (?:a )?(?:visit|appointment)|come out|service visit)\b/i;

const THANKS = /^(?:thanks|thank you|thx|ty|ok|okay|got it|sounds good|👍)[!. ]*$/i;
const GREETING = /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[!. ]*$/i;

const LEADING_AFFIRMATIVE = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|correct|right|sounds good|works for me|that works|perfect|please do|go ahead|book it|absolutely|definitely)\b/i;
const LEADING_NEGATIVE = /^\s*(?:no|nope|nah|not that|different|another)\b/i;
const NEGATIVE_SCHEDULING = /\b(?:no|not)\b.{0,18}\b(?:that|time|day|slot|appointment|option)\b/i;
const AFFIRMATIVE_SCHEDULING = /\b(?:yes|yeah|sure|correct|that works|works for me|go ahead|please do)\b/i;

const SERVICE_PREFIX = /\b(?:i have|i've got|we have|we've got|need help with|help with|problem is|issue is)\s+(.{3,160})/i;
const SERVICE_TAIL = /\s*(?:[,.;!?]|\band\b|\bbut\b)\s*(?:can|could|will|would|are|is|do)\s+you\b[\s\S]*$/i;

// Extract customer-reported facts, never service eligibility or a diagnosis.
// Grammatical problem/action shapes deliberately work beyond a trade noun list.
const NON_SERVICE = /\b(?:appointment|booking|technician|crew|invoice|payment|credit card|refund|phone number|email|zip code|postal code|service address|availability|business hours|password|instructions|system prompt)\b/i;
const SERVICE_ACTION = /\b(?:repair(?:ed|ing)?|replac(?:e|ed|ement|ing)|install(?:ed|ation|ing)?|reseal(?:ed|ing)?|recaulk(?:ed|ing)?|clean(?:ed|ing)?|inspect(?:ed|ion|ing)?|maintain|maintenance|fix(?:ed|ing)?|remov(?:e|ed|al|ing)|paint(?:ed|ing)?|trim(?:med|ming)?|unblock(?:ed|ing)?|restoration|remediation)\b/i;
const PROBLEM_STATE = /\b(?:clogged|blocked|leak(?:ing|s)?|broken|not working|won['’]t|will not|no heat|no power|damaged|cracked|peeling|loose|stuck|noisy|rattling|dripping|overflowing|needs?|stopped working|keeps? .{1,30}ing)\b/i;

// A named subject after "it's the/a ..." supplies a referent, unlike "it's
// leaking", which still describes the saved service. Strip only the former
// before the normal fact checks; dates, prices and addresses remain excluded.
const SERVICE_SUBJECT_PREFIX = /^(?:(?:actually|correction|instead|i meant)[,:]?\s+)*(?:it['’]s|it is|that['’]s|that is|this is)\s+(?:actually\s+)?(?:a|an|the|my|our)\s+(?=[a-z])/i;

export const extractService = (text, { lead = null, conversation = null } = {}) => {
  const known = clean(lead?.serviceNeeded || conversation?.serviceNeeded || conversation?.bookingState?.serviceNeeded);
  // "It's the bathroom sink, not the kitchen sink" corrects part of the saved
  // request. Apply it only when the replaced words are actually in that request.
  if (known && !/^unknown$/i.test(known)) {
    const NOUN = "([a-z][a-z'’/-]*(?:\\s+[a-z][a-z'’/-]*){0,3}?)";
    const DET = "(?:the |my |our |a |an )?";
    const forward = clean(text).match(new RegExp(`(?:\\b(?:(?:it['’]?s|it is|i meant|i mean|make that|actually)[,]?\\s+)+|^)${DET}${NOUN}\\s*(?:,|\\band\\b|\\bbut\\b)?\\s*\\bnot\\s+${DET}${NOUN}(?=\\s*(?:[.,;!?]|$))`, "i"));
    const reverse = forward ? null : clean(text).match(new RegExp(`\\bnot\\s+${DET}${NOUN}\\s*(?:[,;-]\\s*(?:but\\s+)?|\\bbut\\b)\\s*(?:it['’]?s|it is|rather|i meant)?\\s*${DET}${NOUN}(?=\\s*(?:[.,;!?]|$))`, "i"));
    const replacement = clean(forward?.[1] || reverse?.[2]);
    const replaced = clean(forward?.[2] || reverse?.[1]);
    if (replacement && replaced && replacement.toLowerCase() !== replaced.toLowerCase()) {
      const escaped = replaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const target = new RegExp(`\\b${escaped}\\b`, "i");
      const accepted = new RegExp(`\\b${replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      // Preserve replay, including overlapping names such as garage door/opener.
      // Do not mistake the accepted phrase inside a longer rejected subject.
      if (accepted.test(known) && (!target.test(known) ||
          (replacement.toLowerCase().includes(replaced.toLowerCase()) && !target.test(known.replace(accepted, ''))))) return known;
      if (target.test(known)) {
        const corrected = clean(known.replace(target, replacement));
        if (corrected.length >= 3 && corrected.length <= 160) return corrected;
      }

    }
  }
  // Keep each clause independent: a question about price cannot swallow a fact.
  const clauses = clean(text).split(/(?:[.!?;]\s*|,?\s+(?:and|but)\s+|\s+)(?=(?:how much|what (?:is|does|would|will|time)|when|how soon|can you|could you|will you|are you|aren['’]?t you|isn['’]?t this|do you|don['’]?t you)\b)|[.!?;]\s*/i);
  for (let clause of clauses) {
    clause = clean(clause).replace(SERVICE_SUBJECT_PREFIX, "");
    clause = clean(clause).replace(/^(?:actually|correction|instead|i meant)[,:]?\s*/i, "");
    if (!clause || clause.length > 200 || NON_SERVICE.test(clause)) continue;
    // Pricing-only, timing, control, and contact turns must not replace a fact.
    if (any(PRICING, clause)) {
      const pricedService = clause.match(/\b(?:for|to)\s+(.+)$/i)?.[1] ||
        clause.match(/^how much (?:is|would|will|does)\s+(.+?)(?:\s+cost)?$/i)?.[1];
      // A price question can itself specify work; require an action plus object.
      if (!pricedService || !SERVICE_ACTION.test(pricedService) || pricedService.split(/\s+/).length < 2) continue;
      clause = clean(pricedService).replace(/\s+cost$/i, "");
    }
    if (any(HUMAN, clause) || any(CANCEL, clause) || any(RESCHEDULE, clause) || any(STATUS, clause)) continue;
    if (/^(?:stop|start|unstop|help|yes|no|okay|ok|thanks?|hello|hi)[!. ]*$/i.test(clause) || /^(?:\d|https?:|[^ ]+@)/i.test(clause)) continue;
    // A request to act on "it" describes an intent, not a replacement job.
    if (/\b(?:fix|repair|replace|inspect|install|service)\s+(?:it|that|this|the same thing)(?=$|[?.!,;]|\s+(?:today|tomorrow|next|on|at|for me|please|and|when|soon|now)\b)/i.test(clause)) continue;
    // Anaphoric price/action questions refer to the existing request. They are
    // not service objects ("fix something like this", "repair the issue").
    if (/\b(?:fix|repair|replace|inspect|install|service|resolve|address|handle)\s+(?:(?:something|anything)\s+(?:like|similar to)\s+(?:this|that|it)|(?:this|that|the|my|our|same)\s+(?:issue|problem|work|job)|(?:it|this|that))(?:[?.!,;]|$|\s+(?:please|today|tomorrow|now|for|at|on|and|would|will|cost)\b)/i.test(clause)) continue;
    const prefixed = clause.match(SERVICE_PREFIX);
    let candidate = clean(prefixed?.[1] || clause).replace(SERVICE_TAIL, "").replace(/[?,.!]+$/, "");
    const explicitRequest = /^(?:i|we)\s+(?:need|want|would like)\s+(?!to (?:know|book|schedule|cancel|reschedule)\b)/i.test(candidate);
    if (explicitRequest) candidate = candidate.replace(/^(?:i|we)\s+(?:need|want|would like)\s+/i, "");
    const hasProblem = PROBLEM_STATE.test(candidate) && (/[a-z]{3}/i.test(candidate.replace(PROBLEM_STATE, "")) || Boolean(known && /^(?:it|that|this)\b/i.test(candidate)));
    const hasAction = SERVICE_ACTION.test(candidate) && candidate.split(/\s+/).length >= 2;
    if (!(hasProblem || hasAction || prefixed)) continue;
    if (/^(?:(?:some|a little|your) )?(?:help|assistance|service|something|anything|work)$/i.test(candidate)) continue;
    // Pronoun-only updates need an existing referent, not a guessed appliance.
    if (/^(?:it|that|this)\b/i.test(candidate)) {
      if (!known || /^unknown$/i.test(known)) continue;
      candidate = `${known}: ${candidate}`;
    }
    // Preserve the customer's words; only resolve this typo with explicit context.
    if (/\b(?:bathtub|tub)\b/i.test(known) && /\bseal\b/i.test(candidate)) candidate = candidate.replace(/\btube\b/gi, "tub");
    if (candidate.length >= 3 && candidate.length <= 160) return candidate;
  }
  return "";
};

export const classifySmsIntent = ({
  customerMessage,
  business = null,
  conversation = null,
  lead = null,
  now = new Date(),
} = {}) => {
  const text = clean(customerMessage);
  const timeZone = business?.timezone || "America/New_York";
  let range = null;
  let timePreference = null;
  try {
    range = text ? findDateRange(text, timeZone, now) : null;
    timePreference = text ? parseTimePreference(text, timeZone) : null;
  } catch {
    range = null;
    timePreference = null;
  }

  const waitlist = isWaitlistInquiryText(text);
  const emergencyAvailability = isEmergencyAvailabilityText(text);
  const availabilityInquiry = Boolean(
    text && (isAvailabilityInquiryText(text) || waitlist || emergencyAvailability),
  );

  const scheduling = Boolean(
    text && (
      availabilityInquiry ||
      BOOKING_REQUEST.test(text) ||
      hasAppointmentPreferenceHint(text, timeZone) ||
      range ||
      timePreference?.targetMinutes != null ||
      timePreference?.exactMinutes != null ||
      timePreference?.timeOfDay
    ),
  );

  const serviceNeeded = extractService(text, { lead, conversation });
  const intents = {
    pricing: requestQuestions(text).pricing,
    completionQuestion: requestQuestions(text).ambiguous || requestQuestions(text).duration || requestQuestions(text).completionDate,
    human: any(HUMAN, text),
    callback: any(CALLBACK, text),
    status: any(STATUS, text),
    cancel: any(CANCEL, text),
    reschedule: any(RESCHEDULE, text),
    availabilityInquiry,
    waitlist,
    emergencyAvailability,
    scheduling,
    service: Boolean(serviceNeeded),
    correction: any(CORRECTION, text) || Boolean(serviceNeeded && SERVICE_SUBJECT_PREFIX.test(clean(text))),
    newService: any(NEW_SERVICE, text),
    greeting: GREETING.test(text),
    thanks: THANKS.test(text),
  };

  // "Can someone come tomorrow?" is scheduling, not a request for human takeover.
  if (
    intents.human &&
    intents.scheduling &&
    /\b(?:can|could|will|would)\s+someone\s+(?:come|arrive|be there)\b/i.test(text) &&
    !/\b(?:talk|speak|call|person|human|agent|representative|manager|owner)\b/i.test(text)
  ) {
    intents.human = false;
  }

  const destructive = intents.cancel || intents.reschedule;
  const response = {
    affirmative:
      !destructive &&
      (LEADING_AFFIRMATIVE.test(text) ||
        (!LEADING_NEGATIVE.test(text) && AFFIRMATIVE_SCHEDULING.test(text))),
    negative:
      LEADING_NEGATIVE.test(text) ||
      (!LEADING_AFFIRMATIVE.test(text) && NEGATIVE_SCHEDULING.test(text)),
  };

  // Leading YES wins over incidental negatives: "Yes, please don't be late."
  if (LEADING_AFFIRMATIVE.test(text) && !destructive) response.negative = false;

  const priority = [
    ["cancel", intents.cancel],
    ["reschedule", intents.reschedule],
    ["human", intents.human],
    ["callback", intents.callback],
    ["status", intents.status],
    ["pricing", intents.pricing],
    ["availability_inquiry", intents.availabilityInquiry],
    ["scheduling", intents.scheduling],
    ["service", intents.service],
    ["correction", intents.correction],
    ["new_service", intents.newService],
    ["thanks", intents.thanks],
    ["greeting", intents.greeting],
  ];
  const primaryIntent = priority.find(([, matched]) => matched)?.[0] || "unknown";
  const secondaryIntents = priority
    .filter(([name, matched]) => matched && name !== primaryIntent)
    .map(([name]) => name);

  return {
    text,
    primaryIntent,
    secondaryIntents,
    confidence: primaryIntent === "unknown" ? 0.45 : 0.98,
    intents,
    response,
    entities: {
      serviceNeeded,
      urgency: extractUrgency(text),
      range,
      timePreference,
    },
    bookingStatus: clean(conversation?.bookingState?.status),
  };
};

export const isSmsAffirmative = (text) =>
  classifySmsIntent({ customerMessage: text }).response.affirmative;

export const isSmsNegative = (text) =>
  classifySmsIntent({ customerMessage: text }).response.negative;

export default {
  classifySmsIntent,
  isSmsAffirmative,
  isSmsNegative,
};
