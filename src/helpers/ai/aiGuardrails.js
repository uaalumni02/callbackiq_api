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
const SSN_PATTERN = /\b\d{3}-?\d{2}-?\d{4}\b/g;
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
 * Detection is intentionally biased toward false positives: it is far better
 * to escalate a non-emergency to the owner than to send a generic marketing
 * reply to a customer whose house is flooding.
 *
 * [\s\S] is used instead of "." between phrases so patterns still match when
 * the customer's message spans multiple lines.
 */
const SAFETY_HAZARD_PATTERN_GROUPS = [
  /*
   * Medical emergencies come first: when a message describes both a hazard
   * and a person in medical distress ("I smell gas and my wife passed out"),
   * "call 911 right away" is the most important instruction to send.
   */
  {
    type: "medical",
    patterns: [
      /\b(?:heart attack|stroke|seizure|allergic reaction|anaphylaxis)\b/i,
      /\b(?:not breathing|stopped breathing|can['\u2019]?t breathe|trouble breathing|difficulty breathing)\b/i,
      /\b(?:unconscious|unresponsive|passed out|fainted)\b/i,
      /\bchest pains?\b/i,
      /\bbleeding\b(?!\s+(?:the|a|air|valve)\b)/i,
      /\b(?:is|got|was|been|badly|seriously|severely) (?:hurt|injured)\b/i,
      /\binjur(?:ed|y|ies)\b/i,
      /\b(?:got|was|been|badly|severely) burn(?:ed|t)\b/i,
      /\bburn(?:ed|t) (?:himself|herself|myself|themselves|his|her|my)\b/i,
      /\b(?:ambulance|paramedics?|cpr)\b/i,
      /\boverdose\b/i,
      /\b(?:fell|fallen) (?:off|from|down) (?:the )?(?:ladder|roof|stairs)\b/i,
    ],
  },
  {
    type: "gas",
    patterns: [
      /\b(?:smell|smells?|smelling|odor|odour) (?:of )?gas\b/i,
      /\bgas (?:leak|line leak|odor|odour|smell)\b/i,
      /\bpropane (?:leak|smell|odor|odour)\b/i,
      /\bsmells? like rotten eggs\b/i,
      /\brotten egg (?:smell|odor|odour)\b/i,
      /\bcarbon monoxide\b/i,
      /\bco (?:detector|alarm)\b[\s\S]*\b(?:alarm|beeping|going off|triggered)\b/i,
      /\bgas\b[\s\S]{0,60}\bhissing\b/i,
      /\bhissing\b[\s\S]{0,60}\bgas\b/i,
      /\b(?:gas|furnace|water heater|boiler|propane|tank)\b[\s\S]{0,60}\bexplo(?:de|ded|sion|ding)\b/i,
    ],
  },
  {
    type: "fire",
    patterns: [
      /\b(?:electrical|wiring|outlet|panel) (?:fire|smoke|burning)\b/i,
      /\b(?:smoke|fire|flames?)\b/i,
      /\b(?:burning|electrical) smell\b/i,
      /\bsmell (?:something )?burning\b/i,
      /\bsomething(?:['\u2019]s| is) burning\b/i,
      /\bexplo(?:sion|ded|de|ding)\b/i,
    ],
  },
  {
    type: "electrical",
    patterns: [
      /\b(?:electrical )?(?:sparking|arcing)\b/i,
      /\b(?:electrocuted|electric shock|got (?:shocked|zapped))\b/i,
      /\b(?:downed|fallen|live) (?:power line|electrical line|wire)\b/i,
      /\bpower line (?:is )?down\b/i,
      /\bexposed (?:live )?wir(?:e|es|ing)\b/i,
      /\b(?:outlet|wires?|wiring|panel|breaker) (?:is |are )?(?:smoking|melting|buzzing|sizzling|hot to the touch)\b/i,
      /\bwater\b[\s\S]{0,20}\b(?:near|on|in|into|onto|around|touching|leaking|dripping|pouring|coming)\b[\s\S]{0,20}\b(?:outlets?|panel|breaker|electrical|wires?|wiring|light fixture)\b/i,
    ],
  },
  {
    type: "structural",
    patterns: [
      /\b(?:ceiling|roof|walls?|floor|deck|porch|stairs|staircase|chimney|balcony)\b[\s\S]{0,25}\b(?:collaps(?:ed|ing)|caving|caved|giving way|fell in|falling (?:in|down))\b/i,
      /\b(?:ceiling|roof) (?:is )?falling\b(?! apart)/i,
      /\btree (?:fell|has fallen|came down|crashed|landed) (?:on|onto|into|through)\b/i,
      /\b(?:house|home|building|structure) (?:is )?(?:collapsing|unstable|shifting|caving)\b/i,
      /\bcaved? in\b/i,
    ],
  },
  {
    type: "trapped",
    patterns: [
      /\b(?:person|child|kid|baby|pet|dog|cat|someone|somebody|he|she|they|i['\u2019]?m|i am|we['\u2019]?re|we are) (?:is |are |am |got |get )?trapped\b/i,
      /(?<!\bair\s)\btrapped (?:in|under|inside|behind)\b/i,
      /\bstuck (?:under|inside|in the (?:elevator|bathroom|basement|attic|crawl ?space))\b/i,
      /\bchild (?:is )?locked (?:in|inside)\b/i,
    ],
  },
  {
    type: "flood",
    patterns: [
      /*
       * Active flooding, stated directly.
       */
      /\bactive flooding\b/i,
      /\bwater (?:is )?(?:pouring|gushing|flooding)\b/i,
      /\bflood(?:ing|ed)?\s+(?:my|our|the)\s+(?:house|home|basement|apartment|property|kitchen|bathroom|garage|floor)\b/i,
      /\b(?:house|home|basement|apartment|property|kitchen|bathroom|garage)\b[\s\S]*\b(?:is |are )?(?:flooding|flooded|under ?water)\b/i,

      /*
       * Imminent flooding: "it may flood my house", "going to flood".
       */
      /\b(?:may|might|could|going to|about to|gonna|starting to)\s+flood\b/i,

      /*
       * Fear or distress language paired with flooding.
       */
      /\b(?:scared|afraid|terrified|worried|concerned|panicking|panicked|emergency)\b[\s\S]*\bflood/i,

      /*
       * Escalating or uncontrolled water: "the water will not stop",
       * "water is spreading across the floor", "there's water everywhere".
       */
      /\b(?:water|leak|leaking)\b[\s\S]*\b(?:rising|spreading|getting worse|everywhere|won['\u2019]?t stop|will not stop|can['\u2019]?t stop)\b/i,

      /*
       * Burst plumbing.
       */
      /\bburst (?:pipe|water (?:line|main|heater))\b/i,
      /\b(?:pipe|water (?:line|main|heater))\b[\s\S]{0,40}\bburst(?:ed)?\b/i,
      /\bwater (?:coming|leaking|pouring|dripping) (?:through|from|out of|down) (?:the )?(?:ceiling|walls?|floor|light)\b/i,
    ],
  },
  {
    type: "sewage",
    patterns: [/\b(?:sewage|sewer) (?:backup|overflow)\b/i],
  },
  {
    type: "temperature",
    patterns: [
      /\bno heat\b[\s\S]*\b(?:freezing|dangerously cold|below freezing|infant|baby|newborn|elderly|oxygen|medical)\b/i,
      /\b(?:freezing|dangerously cold|infant|baby|newborn|elderly|oxygen|medical condition)\b[\s\S]*\bno heat\b/i,
      /\bno (?:ac|a\/c|air conditioning|cooling)\b[\s\S]*\b(?:heat ?wave|extreme heat|dangerously hot|infant|baby|newborn|elderly|oxygen|medical)\b/i,
      /\b(?:heat ?wave|extreme heat|dangerously hot|infant|baby|newborn|elderly)\b[\s\S]*\bno (?:ac|a\/c|air conditioning|cooling)\b/i,
    ],
  },
  /*
   * Generic distress language. Deliberately last: a more specific hazard
   * type should win when both match, but a customer signaling "emergency"
   * or "call 911" always gets a safety response and a critical alert even
   * when no specific hazard was named.
   *
   * Note: a bare "911" is NOT matched on its own because street addresses
   * ("911 Main St") are a common false positive; call/dial phrasing is.
   */
  {
    type: "other",
    patterns: [
      /\b(?:call(?:ed|ing)?|dial(?:ed|ing)?) 911\b/i,
      /\b(?:this is|it['\u2019]?s|its|we (?:have|are having)|i (?:have|am having)|having) an emergency\b/i,
      /\bemergency situation\b/i,
      /\blife[- ]threatening\b/i,
      /\bin (?:immediate |serious |grave )?danger\b/i,
      /\bsomeone (?:could|might|will|is going to) (?:get hurt|die|be hurt)\b/i,
      /\bneed help (?:now|immediately|right away|asap|fast)\b/i,
      /\bsend help\b/i,
    ],
  },
];

const HAZARDOUS_DIY_PATTERNS = [
  /\bhow (?:do|can|should) i (?:fix|repair|replace|open|disconnect|rewire)\b/i,
  /\bwalk me through\b/i,
  /\btell me how to\b/i,
];

const HAZARDOUS_SYSTEM_PATTERNS = [
  /\bgas (?:line|valve|furnace|water heater)\b/i,
  /\belectrical (?:panel|wiring|service|breaker)\b/i,
  /\bhigh voltage\b/i,
  /\bcarbon monoxide\b/i,
  /\bcombustion\b/i,
  /\bstructural (?:damage|repair|wall|beam)\b/i,
];

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
    "This may be dangerous. Move to a safe location and call 911 if anyone is in immediate danger. The business has been alerted and will follow up as soon as possible.",
  medicalEmergency:
    "If someone is injured, unconscious, or having trouble breathing, call 911 right away — do not wait for a text response. The business has been alerted and will follow up as soon as possible.",
  structuralEmergency:
    "Keep everyone away from the damaged area and leave the building if it feels unsafe. Call 911 if anyone is in immediate danger. The business has been alerted and will follow up as soon as possible.",
  trappedEmergency:
    "Call 911 right away and do not attempt a rescue that could put you in danger. The business has been alerted and will follow up as soon as possible.",
  temperatureEmergency:
    "Extreme indoor heat or cold can be dangerous, especially for children, older adults, and anyone with medical needs. Move anyone at risk somewhere safer and call 911 if there are signs of a medical emergency. The business has been alerted.",
  gasEmergency:
    "If you smell gas or suspect a leak, leave the building now, avoid flames and light switches, and call 911 or your gas utility's emergency line from a safe location. The business has been alerted.",
  fireEmergency:
    "If there is fire or smoke, leave the building immediately and call 911. Do not try to handle it yourself. The business has been alerted.",
  electricalEmergency:
    "Stay away from the affected outlet, wiring, or panel. If it is safe to do so, shut off power at the breaker. Call 911 if there is smoke, fire, or an injury. The business has been alerted.",
  floodEmergency:
    "That sounds urgent. If it is safe to do so, shut off the main water supply and stay away from standing water near outlets, cords, or electrical panels. Call 911 if anyone is in immediate danger. The business has been alerted and will follow up as soon as possible.",
  sewageEmergency:
    "Avoid contact with the backup and keep children and pets away from the area. Call 911 if anyone is in immediate danger. The business has been alerted and will follow up as soon as possible.",

  hazardousDIY:
    "For safety, I cannot guide you through a hazardous repair. Avoid touching the affected equipment and contact emergency services if there is immediate danger. I have marked the request as urgent for the business.",
  help: "CallBackIQ is the business's automated service assistant. Reply with the service you need, or reply STOP to opt out of messages.",
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

export const cleanText = (value, fallback = "") => {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
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
const SAFETY_NEGATION_PREFIX =
  /(?:^|\b)(?:no|never|without|not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|don['’]?t|doesn['’]?t|didn['’]?t|can['’]?t|couldn['’]?t|haven['’]?t|hasn['’]?t|hadn['’]?t|is not|are not|was not|were not|do not|does not|did not|cannot|could not|have not|has not|had not)\b(?:\s+\w+){0,3}\s*$/i;

const SAFETY_FALSE_NEGATION =
  /\bnot\s+(?:only|just)\b/i;

const splitSafetyClauses = (text) =>
  String(text || "")
    .split(
      /(?:[.!?;]+|\b(?:but|however|although|though|yet|except)\b)/i,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);

const isNegatedSafetyMatch = (clause, matchIndex) => {
  /*
   * Limit the scope of negation. This intentionally does not treat a distant
   * "not" elsewhere in the sentence as negating the hazard.
   */
  const prefix = clause
    .slice(Math.max(0, matchIndex - 90), matchIndex)
    .trim();

  if (!prefix) return false;

  /*
   * "not only smoke..." and "not just smoke..." are affirmative mentions,
   * not safety negations.
   */
  if (SAFETY_FALSE_NEGATION.test(prefix.slice(-40))) {
    return false;
  }

  return SAFETY_NEGATION_PREFIX.test(prefix);
};

const patternHasAffirmedSafetyMatch = (pattern, text) => {
  for (const clause of splitSafetyClauses(text)) {
    /*
     * Clone the expression so global/sticky lastIndex state can never leak
     * between calls. Use global matching so a negated first occurrence does
     * not hide a later affirmative occurrence in the same clause.
     */
    const flags = Array.from(
      new Set(
        `${pattern.flags.replace(/[gy]/g, "")}g`
          .split(""),
      ),
    ).join("");

    const matcher = new RegExp(pattern.source, flags);

    let match;

    while ((match = matcher.exec(clause)) !== null) {
      if (!isNegatedSafetyMatch(clause, match.index)) {
        return true;
      }

      // Defensive guard for any zero-length expression.
      if (match[0] === "") {
        matcher.lastIndex += 1;
      }
    }
  }

  return false;
};

/*
 * Returns the hazard type ("gas", "fire", "electrical", "flood", "sewage",
 * "other") when the message describes a safety hazard, or an empty string
 * when it does not. The first matching group wins, and groups are ordered by
 * severity so gas and fire outrank flooding when a message mentions both.
 */
export const detectSafetyHazardType = (value) => {
  const text = cleanText(value);

  if (!text) {
    return "";
  }

  const matchedGroup = SAFETY_HAZARD_PATTERN_GROUPS.find((group) =>
    group.patterns.some((pattern) =>
      patternHasAffirmedSafetyMatch(pattern, text),
    ),
  );

  return matchedGroup ? matchedGroup.type : "";
};

export const containsSafetyHazard = (value) => {
  return detectSafetyHazardType(value) !== "";
};

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

export const containsHazardousDIYRequest = (value) => {
  const text = cleanText(value);

  const requestsInstructions = HAZARDOUS_DIY_PATTERNS.some((pattern) =>
    pattern.test(text),
  );

  const concernsHazardousSystem = HAZARDOUS_SYSTEM_PATTERNS.some((pattern) =>
    pattern.test(text),
  );

  return requestsInstructions && concernsHazardousSystem;
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

  // CALLBACKIQ_SMS_RECOVERY_JOURNEY_SPAM_SCOPE_V1
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
  const hazardType = detectSafetyHazardType(message);

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

  if (containsHazardousDIYRequest(normalizedReply)) {
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
