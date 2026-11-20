import { cleanText } from "./guardrailText.js";
import {
  assessSafetyContext,
  containsHazardousDIYRequest,
  patternHasAffirmedSafetyMatch,
} from "./safetyHazardPolicy.js";

export { cleanText };
export {
  assessSafetyContext,
  containsHazardousDIYRequest,
  containsSafetyHazard,
  detectSafetyHazardType,
  isUrgentPlumbingRequest,
  patternHasAffirmedSafetyMatch,
} from "./safetyHazardPolicy.js";

const SMS_MAX_LENGTH = 320;

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);

const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

const CARD_NUMBER_PATTERN = /(?:\d[ -]*?){13,19}/g;
const SSN_PATTERN = /\b(?:\d{3}-\d{2}-\d{4}|\d{9})\b/g;
const PASSWORD_PATTERN = /\b(password|passcode|pin)\s*[:=]\s*\S+/gi;

const PROMPT_INJECTION_PATTERNS = [
  /ignore (?:all |any )?(?:previous|prior|system|developer) instructions?/i,
  /disregard (?:all |any )?(?:previous|prior|system|developer) instructions?/i,
  /reveal (?:your|the) (?:system|developer) prompt/i,
  /show (?:me )?(?:your|the) (?:system|developer) (?:prompt|instructions?)/i,
  /repeat (?:your|the) (?:system|developer) (?:prompt|instructions?)/i,
  /you are now (?:devmode|developer mode|unrestricted|dan)/i,
  /jailbreak/i,
  /override (?:your|the) (?:rules|guardrails|instructions?)/i,
  /pretend (?:you are|to be) (?:the owner|an administrator|unrestricted)/i,
];

/*
 * Safety hazards are grouped by type so the customer receives a
 * hazard-specific fixed response instead of one generic emergency message.
 *
 * These are conservative routing signals, not diagnoses or emergency monitoring.
 * Routine equipment requests must remain distinguishable from current danger.
 *
 * [\s\S] is used instead of "." between phrases so patterns still match when
 * the customer's message spans multiple lines.
 */
const BLOCKED_APPOINTMENT_PATTERNS = [
  /\b(?:you(?:'re| are)|your appointment(?: is|'s)|we(?:'ve| have))\s+(?:booked|scheduled|confirmed)\b/i,
  /\b(?:booked|scheduled|confirmed)\s+(?:you|your appointment|the appointment)\b/i,
  /\b(?:appointment|visit|service call)\s+(?:has been|is)\s+(?:booked|scheduled|confirmed)\b/i,
  /\bsee you (?:on|at)\b/i,
];

const BLOCKED_AVAILABILITY_PATTERNS = [
  /\bwe (?:have|do have) availability\b/i,
  /\bwe(?:'re| are) available (?:today|tomorrow|on|at)\b/i,
  /\bwe can (?:come|be there|send someone)\b/i,
  /\b(?:a|the) technician is available\b/i,
  /\bwe have someone in your area\b/i,
];

const BLOCKED_DISPATCH_PATTERNS = [
  /\b(?:a|the|our) technician (?:is|will be) on the way\b/i,
  /\b(?:we(?:'ve| have)|i(?:'ve| have)) dispatched\b/i,
  /\bdispatch(?:ed|ing) (?:a|the|our) technician\b/i,
  /\b(?:a|the|our) technician will arrive\b/i,
  /\b(?:our|the) eta is\b/i,
  /\bwe(?:'ll| will) be there in\b/i,
];

const BLOCKED_PRICE_PATTERNS = [
  /\$\s?\d[\d,]*(?:\.\d{1,2})?/,
  /\b(?:cost|price|total|charge|fee) (?:is|will be|would be)\s+\d[\d,]*(?:\.\d{1,2})?\b/i,
  /\b(?:we(?:'ll| will)|i(?:'ll| will)) (?:beat|match) (?:their|that) price\b/i,
  /\b(?:discount|coupon) (?:has been|is) applied\b/i,
  /\bfinancing (?:is|has been) approved\b/i,
];

const BLOCKED_WARRANTY_PATTERNS = [
  /\b(?:that|this|it) is (?:definitely )?(?:under|covered by) warranty\b/i,
  /\bwarranty (?:will|does) cover\b/i,
  /\bcovered at no cost\b/i,
];

const BLOCKED_SERVICE_AREA_PATTERNS = [
  /\byes,? we (?:serve|service|cover) (?:your|that) area\b/i,
  /\b(?:your|that) address is (?:inside|within) our service area\b/i,
  /\bwe (?:serve|service|cover) your (?:city|zip|area)\b/i,
];

const BLOCKED_PAYMENT_PATTERNS = [
  /\b(?:send|text|provide|share) (?:your )?(?:full )?(?:credit|debit) card(?: number)?\b/i,
  /\b(?:send|text|provide|share) (?:your )?(?:cvv|cvc|security code)\b/i,
  /\b(?:send|text|provide|share) (?:your )?(?:bank|routing|account) number\b/i,
  /\b(?:send|text|provide|share) (?:your )?(?:social security|ssn)\b/i,
  /\bpay me by text\b/i,
];

const BLOCKED_GUARANTEE_PATTERNS = [
  /\bwe guarantee\b/i,
  /\bguaranteed (?:repair|result|arrival|completion|outcome)\b/i,
  /\bwe promise\b/i,
  /\bwill definitely (?:fix|resolve|repair|replace)\b/i,
];

const BLOCKED_LEGAL_PATTERNS = [
  /\bwe (?:admit|accept) (?:fault|liability|responsibility)\b/i,
  /\bwe are liable\b/i,
  /\binsurance will (?:cover|pay|reimburse)\b/i,
  /\bwe(?:'ll| will) reimburse\b/i,
  /\bwe(?:'ll| will) refund\b/i,
  /\bsettle (?:your|the) claim\b/i,
];

const BLOCKED_INTERNAL_DISCLOSURE_PATTERNS = [
  /\b(?:my|the) system prompt\b/i,
  /\b(?:my|the) developer instructions\b/i,
  /\binternal (?:prompt|instructions|policy|lead score|risk flag)\b/i,
];

const SAFE_REPLIES = Object.freeze({
  fallback:
    "Thanks for reaching out. I can collect the details for the team, and they will follow up to confirm next steps.",
  appointment:
    "You can reply with the days and times that work best for you. The team must confirm availability before a visit is scheduled; I can’t guarantee a response time.",
  pricing:
    "I can collect the service details, but the team will need to confirm pricing before any work is approved.",
  availability:
    "Please leave the days and times that work best for you. The team must confirm availability before a visit is scheduled; I can’t guarantee a response time.",
  dispatch:
    "I have recorded the urgency. The team will follow up with any confirmed dispatch or arrival information.",
  serviceArea:
    "Please share the service address or ZIP code. The team will confirm whether it is within the service area.",
  warranty:
    "I can document the warranty question, but the team will need to review the account and confirm coverage.",
  payment:
    "For your security, please do not send card, bank, Social Security, password, or access-code information by text. The team will provide an approved payment method if needed.",
  promptInjection:
    "I can only help with service requests and verified information about this business. What service do you need help with?",
  offTopic:
    "I’m here to help with service requests, service details, and scheduling preferences for this business. What service can the team help you with?",

  /*
   * Generic emergency response used only when no hazard-specific reply
   * applies (for example: person trapped, dangerous no-heat situations).
   */
  emergency:
    "This service does not monitor emergencies or dispatch emergency help. If anyone is in immediate danger, call 911 from a safe location. Do not wait for a business reply or callback.",
  medicalEmergency:
    "Call 911 right away for a possible medical emergency. This service does not monitor emergencies or dispatch emergency help. Do not wait for a business reply or callback.",
  structuralEmergency:
    "Stay away from the damaged area. If anyone is in immediate danger, call 911 from a safe location. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback.",
  trappedEmergency:
    "Call 911 for a person or animal trapped in danger. Do not attempt a dangerous rescue. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback.",
  temperatureEmergency:
    "If anyone is in immediate danger or has medical symptoms, call 911. This service does not monitor emergencies or dispatch emergency help. Do not wait for a business reply or callback.",
  gasEmergency:
    "For suspected gas or carbon monoxide danger, leave the area and call 911 or your gas utility emergency line from a safe location. Avoid flames and switches. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback.",
  fireEmergency:
    "For fire or smoke, leave the area and call 911 from a safe location. This service does not monitor emergencies or dispatch emergency help. Do not wait for a business reply or callback.",
  electricalEmergency:
    "Stay away from affected wires, equipment and nearby water. Do not touch them. Call 911 or the utility emergency line for immediate danger. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback.",
  floodEmergency:
    "Stay away from standing water and affected electrical equipment. Call 911 if anyone is in immediate danger. Contact a qualified professional for repairs. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback.",
  sewageEmergency:
    "Avoid contact with sewage and keep children and pets away. Call 911 if anyone is in immediate danger. This service does not monitor emergencies or dispatch emergency help. Do not wait for a business reply or callback.",

  hazardousDIY:
    "I cannot provide instructions for hazardous repairs or bypassing safety devices. Contact a qualified professional. If anyone is in immediate danger, call 911. This service does not monitor emergencies or dispatch emergency help. Do not wait for a callback.",
  help: "MeekCall is the business's automated service assistant. Reply with the service you need, or reply STOP to opt out of messages.",
  optOut:
    "You have been unsubscribed and will no longer receive automated text messages from this business.",
  spam: "I am pausing automated replies because too many or repeated messages were received. The business can review the conversation.",
  sensitiveData:
    "For your security, please do not send card, bank, Social Security, password, or access-code information by text. I can still help collect the basic service details.",
});

const EMERGENCY_REPLY_BY_HAZARD_TYPE = Object.freeze({
  medical: SAFE_REPLIES.medicalEmergency,
  gas: SAFE_REPLIES.gasEmergency,
  fire: SAFE_REPLIES.fireEmergency,
  electrical: SAFE_REPLIES.electricalEmergency,
  structural: SAFE_REPLIES.structuralEmergency,
  trapped: SAFE_REPLIES.trappedEmergency,
  flood: SAFE_REPLIES.floodEmergency,
  sewage: SAFE_REPLIES.sewageEmergency,
  temperature: SAFE_REPLIES.temperatureEmergency,
  other: SAFE_REPLIES.emergency,
});

export const INBOUND_MESSAGE_CATEGORIES = Object.freeze([
  "new_service_request",
  "service_details",
  "appointment_preference",
  "pricing_request",
  "business_information",
  "service_area_question",
  "existing_job_question",
  "complaint",
  "emergency",
  "hazardous_diy_request",
  "payment_information",
  "warranty_question",
  "legal_or_insurance",
  "human_requested",
  "stop",
  "help",
  "prompt_injection",
  "abusive",
  "off_topic",
  "possible_spam",
  "unknown",
]);

export const REPLY_ACTION_TYPES = Object.freeze([
  "acknowledge",
  "request_information",
  "collect_appointment_preference",
  "answer_verified_faq",
  "escalate_to_owner",
  "send_fixed_response",
  "no_reply",
]);

export const GUARDRAIL_DECISIONS = Object.freeze([
  "send",
  "send_fixed_response",
  "alert_owner",
  "no_reply",
]);

export const RISK_FLAGS = Object.freeze([
  "safety_hazard",
  "hazardous_diy_request",
  "possible_spam",
  "automation_loop",
  "legal_threat",
  "payment_concern",
  "sensitive_data",
  "privacy_concern",
  "service_area_issue",
  "unverified_commitment",
  "prompt_injection",
  "angry_customer",
  "competitor_comparison",
  "off_topic",
  "other",
]);

export const SAFETY_HAZARD_TYPES = Object.freeze([
  "medical",
  "gas",
  "fire",
  "electrical",
  "structural",
  "trapped",
  "flood",
  "sewage",
  "temperature",
  "other",
]);

export const URGENCY_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
  "emergency",
]);

export const ALERT_PRIORITIES = Object.freeze([
  "low",
  "medium",
  "high",
  "critical",
]);

export const toBoundedInteger = (value, fallback, minimum, maximum) => {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsedValue));
};

export const clamp = (value, minimum, maximum) => {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, numericValue));
};

export const truncateText = (value, maximumLength) => {
  const text = cleanText(value);

  if (text.length <= maximumLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
};

export const normalizeSmsReply = (value, fallback = SAFE_REPLIES.fallback) => {
  const reply = cleanText(value).replace(/\s+/g, " ").trim();

  return reply ? truncateText(reply, SMS_MAX_LENGTH) : fallback;
};

const normalizeKeyword = (value) => {
  return cleanText(value)
    .replace(/[.!?,;:]+$/g, "")
    .trim()
    .toUpperCase();
};

export const isStopKeyword = (value) => {
  return STOP_KEYWORDS.has(normalizeKeyword(value));
};

export const isHelpKeyword = (value) => {
  return HELP_KEYWORDS.has(normalizeKeyword(value));
};

const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

const passesLuhnCheck = (value) => {
  const digits = digitsOnly(value);

  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);

    if (shouldDouble) {
      digit *= 2;

      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
};

export const detectSensitiveData = (value) => {
  const text = cleanText(value);
  const findings = [];

  if (SSN_PATTERN.test(text)) {
    findings.push("ssn");
  }

  SSN_PATTERN.lastIndex = 0;

  if (PASSWORD_PATTERN.test(text)) {
    findings.push("password_or_code");
  }

  PASSWORD_PATTERN.lastIndex = 0;

  const cardCandidates = text.match(CARD_NUMBER_PATTERN) || [];

  if (cardCandidates.some((candidate) => passesLuhnCheck(candidate))) {
    findings.push("payment_card");
  }

  return findings;
};

export const redactSensitiveData = (value) => {
  let text = cleanText(value);

  text = text.replace(SSN_PATTERN, "[REDACTED_SSN]");
  text = text.replace(PASSWORD_PATTERN, "$1: [REDACTED]");
  text = text.replace(CARD_NUMBER_PATTERN, (candidate) => {
    return passesLuhnCheck(candidate) ? "[REDACTED_PAYMENT_CARD]" : candidate;
  });

  return text;
};

export const containsPromptInjection = (value) => {
  const text = cleanText(value);

  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
};

/*
 * Safety hazards remain deterministic and fail-safe, but a hazard word that
 * appears inside a clearly negated clause must not create a false emergency.
 *
 * Examples:
 *   "There is no flooding."                         -> not a flood hazard
 *   "I don't smell gas."                            -> not a gas hazard
 *   "No, I smell gas."                              -> gas hazard
 *   "There was no flooding earlier, but now it is." -> flood hazard
 *
 * Contrast words and sentence punctuation create independent safety clauses so
 * a negated historical statement cannot suppress a later affirmative hazard.
 */
/*
 * Returns the fixed, hazard-specific customer response for a hazard type.
 * Unknown types fall back to the generic emergency reply so a new hazard
 * category can never produce an empty message.
 */
export const getEmergencyReply = (hazardType) => {
  return (
    EMERGENCY_REPLY_BY_HAZARD_TYPE[cleanText(hazardType)] ||
    SAFE_REPLIES.emergency
  );
};

const getMessageBody = (message) => {
  return cleanText(message?.body || message?.content || message?.message);
};

const getMessageTimestamp = (message) => {
  const timestamp = new Date(
    message?.createdAt || message?.sentAt || 0,
  ).getTime();

  return Number.isFinite(timestamp) ? timestamp : 0;
};

const isInboundMessage = (message) => message?.direction === "inbound";

const isAIOutboundMessage = (message) => {
  if (message?.direction !== "outbound") {
    return false;
  }

  return Boolean(
    message?.isAiGenerated ||
    message?.aiGenerated ||
    message?.generatedBy === "ai" ||
    message?.senderType === "ai" ||
    message?.metadata?.aiGenerated,
  );
};

export const evaluateConversationAbuse = ({
  customerMessage,
  recentMessages = [],
  now = new Date(),
  activityWindowStartAt = null,
}) => {
  const normalizedCurrent = cleanText(customerMessage).toLowerCase();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // Preserve full history for continuity, but scope abuse counters to the
  // current missed-call recovery journey.
  const activityWindowStartMs = activityWindowStartAt
    ? new Date(activityWindowStartAt).getTime()
    : Number.NaN;
  const abuseMessages = Number.isFinite(activityWindowStartMs)
    ? recentMessages.filter(
        (message) => getMessageTimestamp(message) >= activityWindowStartMs,
      )
    : recentMessages;

  const maxInboundPerMinute = toBoundedInteger(
    process.env.AI_MAX_INBOUND_MESSAGES_PER_MINUTE,
    8,
    2,
    60,
  );

  const maxAIRepliesPerHour = toBoundedInteger(
    process.env.AI_MAX_REPLIES_PER_HOUR,
    12,
    1,
    100,
  );

  const maxAITurnsPerConversation = toBoundedInteger(
    process.env.AI_MAX_TURNS_PER_CONVERSATION,
    20,
    1,
    200,
  );

  const duplicateThreshold = toBoundedInteger(
    process.env.AI_DUPLICATE_MESSAGE_THRESHOLD,
    3,
    2,
    10,
  );

  const inboundLastMinute = abuseMessages.filter((message) => {
    return (
      isInboundMessage(message) &&
      nowMs - getMessageTimestamp(message) >= 0 &&
      nowMs - getMessageTimestamp(message) <= 60_000
    );
  }).length;

  if (inboundLastMinute >= maxInboundPerMinute) {
    return {
      blocked: true,
      reason: "inbound_rate_limit",
      riskFlags: ["possible_spam"],
    };
  }

  const aiRepliesLastHour = abuseMessages.filter((message) => {
    return (
      isAIOutboundMessage(message) &&
      nowMs - getMessageTimestamp(message) >= 0 &&
      nowMs - getMessageTimestamp(message) <= 3_600_000
    );
  }).length;

  if (aiRepliesLastHour >= maxAIRepliesPerHour) {
    return {
      blocked: true,
      reason: "ai_hourly_reply_limit",
      riskFlags: ["automation_loop"],
    };
  }

  const totalAIReplies = abuseMessages.filter(isAIOutboundMessage).length;

  if (totalAIReplies >= maxAITurnsPerConversation) {
    return {
      blocked: true,
      reason: "conversation_ai_turn_limit",
      riskFlags: ["automation_loop"],
    };
  }

  const duplicateCount = abuseMessages
    .filter(isInboundMessage)
    .slice(-10)
    .map(getMessageBody)
    .map((body) => body.toLowerCase())
    .filter((body) => body && body === normalizedCurrent).length;

  if (normalizedCurrent && duplicateCount >= duplicateThreshold) {
    return {
      blocked: true,
      reason: "duplicate_message_loop",
      riskFlags: ["possible_spam", "automation_loop"],
    };
  }

  return {
    blocked: false,
    reason: "",
    riskFlags: [],
  };
};

export const evaluateDeterministicInboundGuardrails = ({
  customerMessage,
  recentMessages = [],
  activityWindowStartAt = null,
}) => {
  const message = cleanText(customerMessage);

  if (!message) {
    return {
      handled: true,
      skipAI: true,
      category: "unknown",
      decision: "no_reply",
      actionType: "no_reply",
      reply: "",
      shouldAlertOwner: false,
      alertPriority: "low",
      riskFlags: [],
      hazardType: "",
      reason: "empty_message",
    };
  }

  if (isStopKeyword(message)) {
    return {
      handled: true,
      skipAI: true,
      category: "stop",
      decision: "send_fixed_response",
      actionType: "send_fixed_response",
      reply: SAFE_REPLIES.optOut,
      shouldAlertOwner: false,
      alertPriority: "low",
      riskFlags: [],
      hazardType: "",
      reason: "stop_keyword",
    };
  }

  if (isHelpKeyword(message)) {
    return {
      handled: true,
      skipAI: true,
      category: "help",
      decision: "send_fixed_response",
      actionType: "send_fixed_response",
      reply: SAFE_REPLIES.help,
      shouldAlertOwner: false,
      alertPriority: "low",
      riskFlags: [],
      hazardType: "",
      reason: "help_keyword",
    };
  }

  /*
   * Safety hazards are evaluated BEFORE spam/rate limiting. A customer in an
   * emergency may send several rapid messages, and rate limiting must never
   * silence a safety response or suppress the critical owner alert.
   */
  const safetyContext = assessSafetyContext({ customerMessage: message, recentMessages, activityWindowStartAt });
  const hazardType = safetyContext.hazardType;

  if (hazardType) {
    return {
      handled: true,
      skipAI: true,
      category: "emergency",
      decision: "alert_owner",
      actionType: "send_fixed_response",
      reply: getEmergencyReply(hazardType),
      shouldAlertOwner: true,
      alertPriority: "critical",
      riskFlags: ["safety_hazard"],
      hazardType,
      reason: `safety_hazard_detected:${hazardType}`,
    };
  }

  if (safetyContext.needsClarification) {
    return { handled: true, skipAI: true, category: "service_request", decision: "alert_owner",
      actionType: "send_fixed_response", reply: safetyContext.reply, shouldAlertOwner: true,
      alertPriority: "high", urgency: "high", riskFlags: ["safety_clarification"], hazardType: "",
      reason: "safety_clarification_required" };
  }

  const abuseCheck = evaluateConversationAbuse({
    customerMessage: message,
    recentMessages,
    activityWindowStartAt,
  });

  if (abuseCheck.blocked) {
    return {
      handled: true,
      skipAI: true,
      category: "possible_spam",
      decision: "no_reply",
      actionType: "no_reply",
      reply: "",
      shouldAlertOwner: true,
      alertPriority: "medium",
      riskFlags: abuseCheck.riskFlags,
      hazardType: "",
      reason: abuseCheck.reason,
    };
  }

  if (containsHazardousDIYRequest(message)) {
    return {
      handled: true,
      skipAI: true,
      category: "hazardous_diy_request",
      decision: "alert_owner",
      actionType: "send_fixed_response",
      reply: SAFE_REPLIES.hazardousDIY,
      shouldAlertOwner: true,
      alertPriority: "critical",
      riskFlags: ["hazardous_diy_request", "safety_hazard"],
      hazardType: "",
      reason: "hazardous_diy_request_detected",
    };
  }

  const sensitiveDataFindings = detectSensitiveData(message);

  if (sensitiveDataFindings.length > 0) {
    return {
      handled: true,
      skipAI: true,
      category: "payment_information",
      decision: "alert_owner",
      actionType: "send_fixed_response",
      reply: SAFE_REPLIES.sensitiveData,
      shouldAlertOwner: true,
      alertPriority: "high",
      riskFlags: ["sensitive_data", "payment_concern"],
      hazardType: "",
      reason: `sensitive_data_detected:${sensitiveDataFindings.join(",")}`,
    };
  }

  if (containsPromptInjection(message)) {
    return {
      handled: true,
      skipAI: true,
      category: "prompt_injection",
      decision: "send_fixed_response",
      actionType: "send_fixed_response",
      reply: SAFE_REPLIES.promptInjection,
      shouldAlertOwner: false,
      alertPriority: "low",
      riskFlags: ["prompt_injection"],
      hazardType: "",
      reason: "prompt_injection_detected",
    };
  }

  return {
    handled: false,
    skipAI: false,
    category: "unknown",
    decision: "send",
    actionType: "request_information",
    reply: "",
    shouldAlertOwner: false,
    alertPriority: "low",
    riskFlags: [],
    hazardType: "",
    reason: "",
  };
};

const getVerifiedValue = (source, key) => {
  const entry = source?.[key];

  if (!entry || typeof entry !== "object" || entry.verified !== true) {
    return null;
  }

  return entry.value ?? null;
};

export const buildVerifiedBusinessFacts = (business) => {
  const source =
    business?.aiKnowledge?.verifiedFacts ||
    business?.verifiedBusinessFacts ||
    business?.aiSettings?.verifiedFacts ||
    {};

  const facts = {
    businessHours: getVerifiedValue(source, "businessHours"),
    approvedServices: getVerifiedValue(source, "approvedServices"),
    serviceAreas: getVerifiedValue(source, "serviceAreas"),
    pricing: getVerifiedValue(source, "pricing"),
    emergencyServiceAvailable: getVerifiedValue(
      source,
      "emergencyServiceAvailable",
    ),
    financing: getVerifiedValue(source, "financing"),
    warrantyPolicy: getVerifiedValue(source, "warrantyPolicy"),
    cancellationPolicy: getVerifiedValue(source, "cancellationPolicy"),
    brandsServiced: getVerifiedValue(source, "brandsServiced"),
    diagnosticFee: getVerifiedValue(source, "diagnosticFee"),
  };

  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== null),
  );
};

export const buildBusinessCapabilities = (business) => {
  const settings =
    business?.aiCapabilities || business?.aiSettings?.capabilities || {};

  const verifiedFacts = buildVerifiedBusinessFacts(business);

  const calendarConnected =
    business?.integrations?.calendar?.status === "connected" &&
    business?.integrations?.calendar?.verified === true;

  const dispatchConnected =
    business?.integrations?.dispatch?.status === "connected" &&
    business?.integrations?.dispatch?.verified === true;

  return {
    canCollectLeadDetails: settings.canCollectLeadDetails !== false,
    canCollectAddress: settings.canCollectAddress !== false,
    canCollectAppointmentPreference:
      settings.canCollectAppointmentPreference !== false,

    canConfirmAppointment:
      settings.canConfirmAppointment === true && calendarConnected,

    canConfirmAvailability:
      settings.canConfirmAvailability === true && calendarConnected,

    canConfirmDispatch:
      settings.canConfirmDispatch === true && dispatchConnected,

    canQuotePrices:
      settings.canQuotePrices === true && Boolean(verifiedFacts.pricing),

    canApproveDiscounts: false,
    canApproveFinancing: false,
    canCollectPaymentCardBySms: false,

    canConfirmWarranty:
      settings.canConfirmWarranty === true &&
      Boolean(verifiedFacts.warrantyPolicy),

    canConfirmServiceArea:
      settings.canConfirmServiceArea === true &&
      Boolean(verifiedFacts.serviceAreas),

    canProvideHazardousRepairInstructions: false,
    canAdmitLiability: false,

    aiDisclosureEnabled: business?.aiSettings?.aiDisclosureEnabled !== false,
  };
};

const findMatchingPatterns = (reply, patterns, code, violations) => {
  if (patterns.some((pattern) => pattern.test(reply))) {
    violations.push(code);
  }
};

export const validateOutboundReply = ({
  reply,
  actionType,
  capabilities = {},
  actionEvidence,
}) => {
  const normalizedReply = normalizeSmsReply(reply, "");
  const violations = [];

  if (!REPLY_ACTION_TYPES.includes(actionType)) {
    violations.push("unsupported_action_type");
  }

  if (!normalizedReply && actionType !== "no_reply") {
    violations.push("empty_reply");
  }

  if (normalizedReply.length > SMS_MAX_LENGTH) {
    violations.push("reply_too_long");
  }

  if (actionEvidence && !actionEvidence.requestSubmitted) {
    findMatchingPatterns(normalizedReply, [
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:sent|submitted|forwarded)\b.{0,60}\b(?:request|details|team)\b/i,
      /\b(?:request|appointment)\s+(?:is|has been)\s+(?:under review|submitted|sent|being reviewed)\b/i,
    ], "unverified_request_submission", violations);
  }
  if (actionEvidence && !actionEvidence.ownerAlertCreated) {
    findMatchingPatterns(normalizedReply, [
      /\b(?:i|we)(?:['’]ve| have)?\s+(?:alerted|notified)\s+(?:the |our )?(?:team|staff|owner|dispatcher)\b/i,
      /\b(?:i|we)(?:['’]ve| have)?\s+flagged\b.{0,50}\b(?:team|staff|owner|review)\b/i,
    ], "unverified_owner_alert", violations);
  }

  // The text-only agent has no waitlist mutation tool. Never invent enrollment.
  findMatchingPatterns(normalizedReply, [
    /\b(?:i|we)(?:['’]ve| have)?\s+(?:added|placed|put|enrolled)\s+you\b.{0,60}\b(?:wait[ -]?list|cancellation list|standby list)\b/i,
    /\byou(?:['’]re| are)\s+(?:now\s+)?(?:on|in)\s+(?:the|our|a)\s+(?:wait[ -]?list|cancellation list|standby list)\b/i,
    /\byou(?:['’]re| are)\s+next\b.{0,50}\b(?:cancel|opening)/i,
  ], "unverified_waitlist_enrollment", violations);

  if (!capabilities.canConfirmAppointment) {
    findMatchingPatterns(
      normalizedReply,
      BLOCKED_APPOINTMENT_PATTERNS,
      "unverified_appointment_confirmation",
      violations,
    );
  }

  if (!capabilities.canConfirmAvailability) {
    findMatchingPatterns(
      normalizedReply,
      BLOCKED_AVAILABILITY_PATTERNS,
      "unverified_availability_claim",
      violations,
    );
  }

  if (!capabilities.canConfirmDispatch) {
    findMatchingPatterns(
      normalizedReply,
      BLOCKED_DISPATCH_PATTERNS,
      "unverified_dispatch_claim",
      violations,
    );
  }

  if (!capabilities.canQuotePrices) {
    findMatchingPatterns(
      normalizedReply,
      BLOCKED_PRICE_PATTERNS,
      "unverified_price_or_financing_claim",
      violations,
    );
  }

  if (!capabilities.canConfirmWarranty) {
    findMatchingPatterns(
      normalizedReply,
      BLOCKED_WARRANTY_PATTERNS,
      "unverified_warranty_claim",
      violations,
    );
  }

  if (!capabilities.canConfirmServiceArea) {
    findMatchingPatterns(
      normalizedReply,
      BLOCKED_SERVICE_AREA_PATTERNS,
      "unverified_service_area_claim",
      violations,
    );
  }

  findMatchingPatterns(
    normalizedReply,
    BLOCKED_PAYMENT_PATTERNS,
    "sensitive_payment_request",
    violations,
  );

  findMatchingPatterns(
    normalizedReply,
    BLOCKED_GUARANTEE_PATTERNS,
    "guarantee_or_outcome_promise",
    violations,
  );

  findMatchingPatterns(
    normalizedReply,
    BLOCKED_LEGAL_PATTERNS,
    "legal_or_liability_commitment",
    violations,
  );

  findMatchingPatterns(
    normalizedReply,
    BLOCKED_INTERNAL_DISCLOSURE_PATTERNS,
    "internal_information_disclosure",
    violations,
  );

  const unsafeInstructions = [
    /\b(?:bypass|disable|jump|short)\b[^.!?;]{0,30}\b(?:safety sensor|interlock|breaker|safety switch)\b/i,
    /\b(?:open|remove|disconnect|rewire)\b[^.!?;]{0,25}\b(?:electrical panel|live wire|gas line)\b/i,
    /\b(?:adjust|release|wind|unwind)\b[^.!?;]{0,25}\b(?:torsion spring|garage door spring)\b/i,
    /\b(?:shut|turn|switch) off (?:the )?(?:main )?(?:power|breaker|water supply)\b/i,
  ].some(pattern => patternHasAffirmedSafetyMatch(pattern, normalizedReply));
  if (unsafeInstructions || containsHazardousDIYRequest(normalizedReply)) {
    violations.push("hazardous_repair_instruction");
  }

  return {
    allowed: violations.length === 0,
    reply: normalizedReply,
    violations: [...new Set(violations)],
  };
};

const chooseFallbackReply = ({
  category,
  violations = [],
  hazardType = "",
}) => {
  if (
    category === "emergency" ||
    violations.includes("hazardous_repair_instruction")
  ) {
    return getEmergencyReply(hazardType);
  }

  if (violations.includes("sensitive_payment_request")) {
    return SAFE_REPLIES.payment;
  }

  if (violations.some(value => ["unverified_request_submission", "unverified_owner_alert"].includes(value))) {
    return "Your appointment still needs business confirmation. I can help collect the remaining service details here.";
  }

  if (violations.includes("unverified_waitlist_enrollment")) {
    return "I can’t enroll you in a managed waitlist here. Would you like to check for an earlier appointment?";
  }

  if (violations.includes("unverified_appointment_confirmation")) {
    return SAFE_REPLIES.appointment;
  }

  if (violations.includes("unverified_availability_claim")) {
    return SAFE_REPLIES.availability;
  }

  if (violations.includes("unverified_dispatch_claim")) {
    return SAFE_REPLIES.dispatch;
  }

  if (violations.includes("unverified_price_or_financing_claim")) {
    return SAFE_REPLIES.pricing;
  }

  if (violations.includes("unverified_warranty_claim")) {
    return SAFE_REPLIES.warranty;
  }

  if (violations.includes("unverified_service_area_claim")) {
    return SAFE_REPLIES.serviceArea;
  }

  if (category === "off_topic" || category === "abusive") {
    return SAFE_REPLIES.offTopic;
  }

  if (category === "prompt_injection") {
    return SAFE_REPLIES.promptInjection;
  }

  return SAFE_REPLIES.fallback;
};

const hasAIDisclosure = (reply) => {
  return /\b(?:automated|virtual|ai) (?:assistant|receptionist)\b/i.test(reply);
};

export const addAIDisclosureIfNeeded = ({
  reply,
  businessName,
  isFirstAIReply,
  disclosureEnabled = true,
}) => {
  const normalizedReply = normalizeSmsReply(reply);

  if (
    !isFirstAIReply ||
    !disclosureEnabled ||
    hasAIDisclosure(normalizedReply)
  ) {
    return normalizedReply;
  }

  const disclosure = businessName
    ? `I'm the automated assistant for ${cleanText(businessName)}.`
    : "I'm the business's automated assistant.";

  return normalizeSmsReply(`${disclosure} ${normalizedReply}`);
};

export const sanitizeOutboundReply = ({
  reply,
  actionType,
  category,
  capabilities,
  businessName,
  hazardType = "",
  isFirstAIReply = false,
  addDisclosure = true,
  actionEvidence,
}) => {
  /*
   * The first abusive, inappropriate, or unrelated message receives a concise
   * professional redirect. Existing spam and automation-loop protections can
   * still stop replies when the behavior continues.
   */
  const isInappropriateReply =
    category === "abusive" || category === "off_topic";

  const selectedReply = isInappropriateReply ? SAFE_REPLIES.offTopic : reply;

  const replyWithDisclosure = addAIDisclosureIfNeeded({
    reply: selectedReply,
    businessName,
    isFirstAIReply,
    disclosureEnabled:
      addDisclosure && capabilities?.aiDisclosureEnabled !== false,
  });

  const validation = validateOutboundReply({
    reply: replyWithDisclosure,
    actionType,
    capabilities,
    actionEvidence,
  });

  if (validation.allowed) {
    return {
      reply: validation.reply,
      allowed: true,
      usedFallback: false,
      violations: [],
    };
  }

  const fallback = chooseFallbackReply({
    category,
    violations: validation.violations,
    hazardType,
  });

  const safeFallback = addAIDisclosureIfNeeded({
    reply: fallback,
    businessName,
    isFirstAIReply,
    disclosureEnabled:
      addDisclosure && capabilities?.aiDisclosureEnabled !== false,
  });

  return {
    reply: safeFallback,
    allowed: false,
    usedFallback: true,
    violations: validation.violations,
  };
};

export const isFirstAIReply = (messages = []) => {
  if (!Array.isArray(messages)) {
    return true;
  }

  return !messages.some(isAIOutboundMessage);
};

export { SAFE_REPLIES, SMS_MAX_LENGTH };
