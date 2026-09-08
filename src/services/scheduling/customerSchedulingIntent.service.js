// CallBackIQ production scheduling language policy.
// Shared by SMS and Voice so customer wording cannot route differently by channel.

const clean = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const TRADE_ROLE =
  String.raw`(?:tech|technician|crew|plumber|electrician|roofer|locksmith|landscaper|contractor)`;
const PERSON_OR_ROLE =
  String.raw`(?:you|your team|someone|somebody|anyone|anybody|(?:a|an|the)\s+${TRADE_ROLE})`;
const ARRIVAL_VERB =
  String.raw`(?:come(?:\s+out)?|arrive|get\s+here|be\s+here|visit|show\s+up)`;

const AVAILABILITY_PATTERNS = [
  /\b(?:check|find|any|an?|something|anything)\b.{0,25}\bearlier\b(?:.{0,20}\b(?:appointment|opening|time|slot)\b)?/i,
  new RegExp(
    String.raw`\bwhen\s+(?:can|could|would|will|might)\s+${PERSON_OR_ROLE}\s+${ARRIVAL_VERB}\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bhow\s+(?:soon|quickly|fast)\s+(?:can|could|would|will|might)\s+${PERSON_OR_ROLE}\s+${ARRIVAL_VERB}\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bhow\s+(?:soon|quickly|fast)\s+(?:can|could|would|will|might)\s+you\s+(?:send|dispatch|get)\s+(?:someone|somebody|anyone|anybody|(?:a|an|the)\s+${TRADE_ROLE})\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:can|could|would|will)\s+${PERSON_OR_ROLE}\s+${ARRIVAL_VERB}(?:\s+(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|next\s+week|this\s+week))?\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bwhat\s+time\s+(?:can|could|would|will)\s+${PERSON_OR_ROLE}\s+${ARRIVAL_VERB}\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bcan\s+you\s+(?:send|dispatch|get)\s+(?:someone|somebody|anyone|anybody|(?:a|an|the)\s+${TRADE_ROLE})\b`,
    "i",
  ),
  /\bwhen(?:['’]s| is)?\s+(?:your|the|your team(?:['’]s)?)?\s*(?:next|earliest|soonest)\s+(?:available\s+)?(?:appointment|opening|time|slot|visit|service\s+call)\b/i,
  /\bwhat(?:['’]s| is)?\s+(?:your|the|your team(?:['’]s)?)?\s*(?:earliest|soonest|next)\s+(?:opening|availability|available\s+time|appointment|slot|visit)\b/i,
  /\b(?:what|which)\s+(?:times?|slots?|openings?|appointments?)\s+(?:do\s+you\s+have|are\s+available|are\s+open|can\s+you\s+offer)\b/i,
  /\bdo\s+you\s+have\s+(?:(?:any|anything|something)\s+)?(?:times?|slots?|openings?|appointments?)?\s*(?:available|open|free)?\b/i,
  /\b(?:any|what)\s+(?:openings?|open\s+times?|available\s+times?|available\s+slots?|appointments?)\b/i,
  new RegExp(
    String.raw`\b(?:anyone|anybody|someone|somebody|(?:a|an|the)\s+${TRADE_ROLE})\s+(?:available|free|open)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:are|is)\s+(?:you|anyone|anybody|someone|somebody|(?:a|an|the)\s+${TRADE_ROLE})\s+(?:available|free)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\bcan\s+(?:i|we)\s+(?:get|have)\s+(?:someone|somebody|anyone|anybody|(?:a|an|the)\s+${TRADE_ROLE})\s+(?:out|here|to\s+(?:my|the)\s+(?:house|home|property|business))\b`,
    "i",
  ),
  /\bwhen\s+(?:can|could|would)\s+(?:i|we)\s+(?:schedule|book|get)\s+(?:an?\s+)?(?:appointment|visit|service\s+call)\b/i,
  /\bcan\s+you\s+(?:fit|squeeze)\s+(?:me|us)\s+in\b/i,
  /\bwhat\s+does\s+(?:your|the)\s+(?:schedule|calendar)\s+look\s+like\b/i,
  /\b(?:got|have)\s+(?:anything|something)\s+(?:today|tomorrow|this\s+(?:morning|afternoon|evening)|tonight|this\s+week|next\s+week)\b/i,
  /\b(?:earliest|soonest)\s+(?:you\s+can|you\s+could|available|opening|appointment|slot)\b/i,
  // Customer SMS is noisy; tolerate "you availability" as well as "your availability".
  /\bwhat(?:['’]s| is)?\s+(?:(?:you|your)\s+)?availability\b/i,
  /\bwhat\s+availability\s+(?:do|does|can)\s+(?:you|your team|the business)\s+(?:have|offer)\b/i,
  /^\s*are\s+you\s+available\b/i,
];

const EXPLICIT_HUMAN_PATTERNS = [
  /\b(?:talk|speak)\s+(?:to|with)\s+(?:(?:a|an|the)\s+)?(?:human|person|representative|agent|operator|owner|manager|dispatcher|staff(?:\s+member)?)\b/i,
  /\b(?:transfer|connect|put)\s+me(?:\s+through)?\s+(?:to|with)?\s*(?:(?:a|an|the)\s+)?(?:human|person|representative|agent|operator|owner|manager|dispatcher|staff(?:\s+member)?)\b/i,
  /\b(?:real\s+person|live\s+agent|human\s+representative|customer\s+service\s+representative)\b/i,
  /\b(?:call\s+me\s+back|give\s+me\s+a\s+call|have\s+(?:the\s+)?team\s+call\s+me|ask\s+(?:someone|somebody|the\s+team)\s+to\s+call\s+me)\b/i,
  /\b(?:not\s+a\s+bot|get\s+me\s+(?:a\s+)?(?:human|person)|stop\s+(?:the\s+)?automation)\b/i,
];

const EMERGENCY_URGENCY = [
  /\b(?:gas\s+(?:smell|odor)|smell(?:s|ing)?\s+(?:like\s+)?gas|carbon\s+monoxide|co\s+alarm)\b/i,
  /\b(?:fire|smoke|electrical\s+fire|sparking|arcing|live\s+wire|downed\s+power\s+line)\b/i,
  /\b(?:burst\s+pipe|pipe\s+(?:has\s+|is\s+)?burst|gushing\s+water|water\s+(?:is\s+)?gushing|uncontrolled\s+flood(?:ing)?|major\s+flood)\b/i,
  /\b(?:structural\s+collapse|roof\s+collapse|tree\s+(?:fell|fallen)\s+on\s+(?:the\s+)?(?:house|home|building))\b/i,
];

const HIGH_URGENCY = [
  /\bleaking\s+water\b|\bdish\s*washer\b.{0,25}\bleak(?:s|ing)?\b/i,
  /\b(?:active(?:ly)?\s+leak(?:ing)?|water\s+leak(?:ing)?|roof\s+(?:is\s+)?(?:active(?:ly)?\s+)?leak(?:ing)?|water\s+coming\s+in|water\s+intrusion)\b/i,
  /\b(?:water\s+heater|hot\s+water\s+heater).{0,30}\bleak(?:ing|s|ed)?\b/i,
  /\bleak(?:ing|s|ed)?\b.{0,40}\b(?:floor|ceiling|wall|cabinet|room)\b/i,
  /\b(?:loss\s+of\s+service|no\s+service|without\s+service|completely\s+unusable)\b/i,
  /\b(?:no\s+heat|no\s+(?:ac|a\/c|air\s+conditioning|cooling)|no\s+power|no\s+hot\s+water)\b/i,
  /\b(?:sewage|sewer\s+backup|overflow(?:ing)?|backing\s+up)\b/i,
  /\b(?:locked\s+out|cannot\s+get\s+in|can't\s+get\s+in)\b/i,
  /\b(?:garage\s+door\s+(?:is\s+)?(?:stuck\s+open|stuck\s+closed|won't\s+close|will\s+not\s+close)|door\s+won't\s+secure)\b/i,
  /\b(?:storm\s+damage|wind\s+damage|hail\s+damage|tree\s+blocking\s+(?:the\s+)?driveway)\b/i,
  /\b(?:won't\s+stop|will\s+not\s+stop|asap|as\s+soon\s+as\s+possible|urgent)\b/i,
];

export const isWaitlistInquiryText = (value) =>
  /\b(?:wait[ -]?list|cancellation list|standby list)\b/i.test(clean(value));

export const isEmergencyAvailabilityText = (value) =>
  /\b(?:emergency|urgent|after[ -]hours)\s+(?:time|slot|appointment|visit|service|availability|opening|call[ -]?out)s?\b|\b(?:do you|can you)\b.{0,30}\b(?:emergency|emergencies)\b/i.test(clean(value));

export const isAvailabilityInquiryText = (value) => {
  const text = clean(value);
  if (!text) return false;

  if (
    /^(?:i(?:'m| am)|we(?:'re| are))\s+available\b/i.test(text) ||
    /\b(?:works\s+for\s+me|is\s+best\s+for\s+me|i\s+prefer|we\s+prefer)\b/i.test(text)
  ) {
    return false;
  }

  if (isEmergencyAvailabilityText(text)) return true;
  return AVAILABILITY_PATTERNS.some((pattern) => pattern.test(text));
};

const isExplicitHumanRequestTextBase = (value) => {
  const text = clean(value);
  if (!text) return false;
  return EXPLICIT_HUMAN_PATTERNS.some((pattern) => pattern.test(text));
};

export const isDispatchSchedulingQuestion = (value) =>
  isAvailabilityInquiryText(value);

export const classifyOperationalUrgency = (value) => {
  const text = clean(value);
  if (!text) return "";
  if (EMERGENCY_URGENCY.some((pattern) => pattern.test(text))) return "emergency";
  if (HIGH_URGENCY.some((pattern) => pattern.test(text))) return "high";
  return "";
};


// CALLBACKIQ_EXPLICIT_HUMAN_ROUTING_FINAL
//
// Explicit requests for HUMAN OWNERSHIP must win even when the same
// sentence also contains booking/scheduling language.
//
// Requests for a PERSON/TECHNICIAN TO PHYSICALLY ARRIVE remain scheduling,
// not human-transfer intent.

const EXPLICIT_HUMAN_ROLE_REQUEST =
  /\b(?:i\s+)?(?:want|need|prefer|would\s+like|request|requesting)\s+(?:to\s+)?(?:(?:talk|speak)\s+(?:to|with)\s+)?(?:(?:a|an|the)\s+)?(?:human|person|representative|agent|operator|owner|manager|dispatcher|staff(?:\s+member)?)\b/i;

const EXPLICIT_HUMAN_COMMUNICATION_REQUEST =
  /\b(?:talk|speak)\s+(?:to|with)\s+(?:(?:a|an|the)\s+)?(?:human|person|representative|agent|operator|owner|manager|dispatcher|staff(?:\s+member)?|someone|somebody)\b|\b(?:transfer|connect|put)\s+me(?:\s+through)?(?:\s+to)?\s+(?:(?:a|an|the)\s+)?(?:human|person|representative|agent|operator|owner|manager|dispatcher|staff(?:\s+member)?)\b/i;

const FIELD_SERVICE_ARRIVAL_REQUEST =
  /\b(?:can|could|will|would)\s+(?:someone|somebody|(?:(?:a|the)\s+)?(?:person|human|tech|technician)|your\s+team)\s+(?:come|come\s+out|arrive|be\s+there|visit)\b|\b(?:want|need|would\s+like)\s+(?:(?:a|the)\s+)?(?:person|human|someone|somebody|tech|technician)\s+to\s+(?:come|come\s+out|arrive|be\s+there|visit)\b/i;

export const isExplicitHumanRequestText = (value) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return false;

  // "Can someone come tomorrow?" = service arrival, not takeover.
  if (FIELD_SERVICE_ARRIVAL_REQUEST.test(text)) {
    return false;
  }

  // "I want a person to book the appointment." = explicit human ownership.
  if (EXPLICIT_HUMAN_ROLE_REQUEST.test(text)) {
    return true;
  }

  if (EXPLICIT_HUMAN_COMMUNICATION_REQUEST.test(text)) {
    return true;
  }

  return isExplicitHumanRequestTextBase(text);
};


export default {
  isAvailabilityInquiryText,
  isExplicitHumanRequestText,
  isDispatchSchedulingQuestion,
  classifyOperationalUrgency,
};
