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

export const extractService = (text) => {
  text = clean(text).split(/(?:[.!?]\s*|\s+)(?=(?:when|how soon|what time)\b)/i)[0];
  const problem = text.match(/\b(?:my|our)\s+.{1,110}\b(?:clogged|blocked|leak(?:ing|s)?|broken|not working|won['’]t|no heat|no power)\b[^.!?]*/i) ||
    text.match(/\b(?:kitchen sink|sink|dish\s*washer|toilet|drain|water heater|furnace|air conditioner|garage door|roof)\b.{0,60}\b(?:clogged|blocked|leak(?:ing|s)?|broken|not working)\b[^.!?]*/i);
  if (problem) return clean(problem[0]).slice(0, 160);
  const match = text.match(SERVICE_PREFIX);
  if (!match?.[1]) return "";
  const candidate = clean(match[1].replace(SERVICE_TAIL, "").replace(/[?.!]+$/, ""));
  if (candidate.length < 3 || candidate.length > 120) return "";
  if (any(PRICING, candidate)) return "";
  return candidate;
};

export const classifySmsIntent = ({
  customerMessage,
  business = null,
  conversation = null,
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

  const intents = {
    pricing: any(PRICING, text),
    human: any(HUMAN, text),
    callback: any(CALLBACK, text),
    status: any(STATUS, text),
    cancel: any(CANCEL, text),
    reschedule: any(RESCHEDULE, text),
    availabilityInquiry,
    waitlist,
    emergencyAvailability,
    scheduling,
    service: Boolean(extractService(text)),
    correction: any(CORRECTION, text),
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
      serviceNeeded: extractService(text),
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
