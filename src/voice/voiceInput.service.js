import { normalizeEmergencyNumberForSpeech } from "./voiceSpeech.service.js";
import { extractCustomerPostalCode } from '../services/booking/customerAddress.service.js';
import {
  digitsOnly,
  normalizePhoneToE164,
  speakDigits,
} from "./voicePhone.service.js";
import {
  isAvailabilityInquiryText,
  isExplicitHumanRequestText,
} from "../services/scheduling/customerSchedulingIntent.service.js";

const WORD_DIGITS = Object.freeze({
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  to: "2",
  too: "2",
  three: "3",
  four: "4",
  for: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  ate: "8",
  nine: "9",
});

const YES_PATTERN = /^(?:yes|yeah|yep|correct|right|that(?:'s| is) correct|sounds good|please do|confirm)(?:\s|[.!])*$/i;
const NO_PATTERN = /^(?:no|nope|incorrect|wrong|not correct|change it|that(?:'s| is) wrong)(?:\s|[.!])*$/i;
const CANCEL_PATTERN = /\b(?:never\s*mind|cancel(?:\s+that)?|stop(?:\s+this)?|forget it|do not submit|don't submit|no callback|leave it alone)\b/i;
const SKIP_PATTERN = /\b(?:skip(?:\s+(?:it|that|this|one))?|rather not say|prefer not to say|do not know|don't know|not sure|unknown|not provided|none)\b/i;
const REPEAT_PATTERN = /\b(?:repeat that|say that again|what did you say|come again|could you repeat|repeat the question)\b/i;
const HUMAN_PATTERN = /(?:\b(?:human|person|representative|agent|operator|someone|somebody|owner|manager|dispatcher|technician|staff(?:\s+member)?)\b|\b(?:transfer|connect|put)\s+me(?:\s+through)?\b|\b(?:talk|speak)(?:\s+to|\s+with)\s+(?:(?:a|an|the)\s+)?(?:person|human|representative|agent|operator|someone|somebody|staff(?:\s+member)?|owner|manager|dispatcher|technician)\b)/i;
const BOOKING_PATTERN = /\b(?:book|booking|schedule|appointment|available|availability|come out|service visit|send someone|reserve|confirm a time|cancel|reschedule)\b|\bchange\b.{0,20}\b(?:time|day|appointment)\b/i;
const CALLBACK_FORWARD_PATTERN = /\b(?:please\s+)?(?:call me back|give me a call back|have (?:the )?team call me|ask (?:the )?team to call me|leave (?:a )?message|request (?:a )?callback)\b/i;
const CALLBACK_PAST_PATTERN = /\b(?:i|we)\s+(?:called|call)\s+back\b|\breturning (?:your|a) call\b/i;
const HOURS_CONTEXT_PATTERN = /\b(?:when|today|tomorrow|tonight|weekend|weekday|saturday|sunday|day|days|time|hours|currently|right now)\b/i;
const OPEN_CLOSE_PATTERN = /\b(?:open|close|closed|closing|opening)\b/i;
const HOURS_DIRECT_PATTERN = /\b(?:business hours|operating hours|hours of operation|what time do you (?:open|close)|when are you open|are you open|are you closed)\b/i;
const AREA_PATTERN = /\b(?:service area|serve|servicing|cover|coverage|come to|travel to|work in|go to|service my area|service this area)\b/i;
const DIRECTED_ABUSE_PATTERN = /\b(?:you|your|y’all|yall|the company|this business|your business|your people)\b.{0,40}\b(?:fuck|shit|bitch|asshole|idiot|stupid|moron|scam|crook)\b|\b(?:fuck you|you suck|your company sucks)\b/i;
const EXPLICIT_LANGUAGE_PATTERN = /\b(?:spanish|espa[nñ]ol|french|fran[cç]ais|portuguese|portugu[eê]s|interpreter|translator|translation)\b/i;
const NON_ENGLISH_MARKERS = new Set([
  // Spanish
  "necesito", "ayuda", "por", "favor", "hablo", "hablar", "espanol",
  "cita", "plomero", "fontanero", "fuga", "agua", "calefaccion",
  "reparacion", "servicio", "alguien",
  // French
  "besoin", "aide", "francais", "parler", "rendez", "plombier", "fuite",
  "reparation", "quelquun",
  // Portuguese
  "preciso", "ajuda", "portugues", "falar", "encanador", "vazamento",
  "reparo", "alguem",
]);
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MILITARY_TIME_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const ZIP_PATTERN = /\b(\d{5})(?:-\d{4})?\b/;

export const cleanVoiceText = (value, maximum = 2000) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);

export const isYes = (value) => YES_PATTERN.test(cleanVoiceText(value, 120));
export const isNo = (value) => NO_PATTERN.test(cleanVoiceText(value, 120));
export const isCancelIntent = (value) => CANCEL_PATTERN.test(cleanVoiceText(value, 300));
export const isSkipIntent = (value) => SKIP_PATTERN.test(cleanVoiceText(value, 300));
export const isRepeatIntent = (value) => REPEAT_PATTERN.test(cleanVoiceText(value, 300));
export const isHumanRequest = (value) =>
  isExplicitHumanRequestText(cleanVoiceText(value, 500));
export const isVoiceAvailabilityInquiry = (value) =>
  isAvailabilityInquiryText(cleanVoiceText(value, 500));
export const isBookingIntent = (value) => {
  const text = cleanVoiceText(value, 500);
  return BOOKING_PATTERN.test(text) || isAvailabilityInquiryText(text);
};
export const isCallbackRequest = (value) => {
  const text = cleanVoiceText(value, 500);
  return CALLBACK_FORWARD_PATTERN.test(text) && !CALLBACK_PAST_PATTERN.test(text);
};
export const isBusinessHoursQuestion = (value) => {
  const text = cleanVoiceText(value, 500);
  if (HOURS_DIRECT_PATTERN.test(text)) return true;
  return OPEN_CLOSE_PATTERN.test(text) && HOURS_CONTEXT_PATTERN.test(text);
};
export const isServiceAreaQuestion = (value) => AREA_PATTERN.test(cleanVoiceText(value, 500));
export const containsAbuse = (value) => DIRECTED_ABUSE_PATTERN.test(cleanVoiceText(value, 1000));

const spokenDigits = (value) => {
  const tokens = cleanVoiceText(value, 500)
    .toLowerCase()
    .replace(/[-,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let best = "";
  let current = "";
  for (const token of tokens) {
    const digit = /^\d$/.test(token) ? token : WORD_DIGITS[token];
    if (digit != null) {
      current += digit;
      if (current.length > best.length) best = current;
    } else {
      current = "";
    }
  }
  return best;
};

export const extractPostalCode = (value) => {
  const text = cleanVoiceText(value, 500);
  const direct = extractCustomerPostalCode(text);
  if (direct) return direct;
  const words = spokenDigits(text);
  return words.length >= 5 ? words.slice(0, 5) : "";
};

export const extractPhoneNumber = (value) => {
  const text = cleanVoiceText(value, 500);

  // Never normalize every digit in an arbitrary sentence. A ZIP code, street
  // number, date, or appointment time could otherwise be concatenated into a
  // believable but incorrect callback number. Prefer bounded phone-shaped runs.
  const candidates = text.match(
    /(?:\+?1[\s().-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}\b/g,
  ) || [];
  for (const candidate of candidates) {
    const normalized = normalizePhoneToE164(candidate);
    if (normalized) return normalized;
  }

  const words = spokenDigits(text);
  if (words.length === 10 || (words.length === 11 && words.startsWith("1"))) {
    return normalizePhoneToE164(words);
  }

  return "";
};

export const formatClockTimeForSpeech = (hoursValue, minutesValue = "00") => {
  const hours = Number(hoursValue);
  const minutes = Number(minutesValue);
  if (!Number.isInteger(hours) || hours < 0 || hours > 24) return "";
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return "";
  if (hours === 24 && minutes === 0) return "midnight";

  const suffix = hours >= 12 ? "p.m." : "a.m.";
  const twelveHour = hours % 12 || 12;
  return minutes === 0
    ? `${twelveHour} ${suffix}`
    : `${twelveHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

const spaceLikelyZipCodes = (value) =>
  value.replace(/\b(\d{5})(?:-(\d{4}))?\b/g, (_match, primary, extension) => {
    const main = speakDigits(primary);
    return extension ? `${main}, extension ${speakDigits(extension)}` : main;
  });

export const toSpokenReply = (value) => {
  let text = cleanVoiceText(value, 4000)
    .replace(URL_PATTERN, "the website link")
    .replace(EMAIL_PATTERN, "the email address")
    .replace(/\bReply YES\b/gi, "Say yes")
    .replace(/\bPlease reply\b/gi, "Please say")
    .replace(/\bPlease send\b/gi, "Please say")
    .replace(/\bYou can reply with\b/gi, "You can say")
    .replace(/\bReply with\b/gi, "Say")
    .replace(/\bReply here\b/gi, "Tell me")
    .replace(/\bsend another day\b/gi, "say another day")
    .replace(/\bby SMS\b/gi, "by text")
    .replace(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*([ap])\.?m\.?(?![a-z])/gi,
      (_match, hours, minutes, period) => `${Number(hours)}${minutes === "00" ? "" : `:${minutes}`} ${period.toLowerCase()}.m.`)
    .replace(MILITARY_TIME_PATTERN, (match, hours, minutes, offset, source) =>
      // Already spoken 12-hour times must survive repeated normalization.
      /^\s*[ap]\.?m\.?/i.test(source.slice(offset + match.length))
        ? match : formatClockTimeForSpeech(hours, minutes),
    );

  text = text.replace(/([ap]\.m\.)\.+/gi, "$1");
  text = spaceLikelyZipCodes(text);
  return cleanVoiceText(normalizeEmergencyNumberForSpeech(text), 4000);
};

export const parseCorrection = (value) => {
  const text = cleanVoiceText(value, 600);
  const match = text.match(
    /^(?:no[, ]+)?(?:i (?:said|meant)|correction|actually|change|update)\s+(?:(?:my|the)\s+)?(name|address|location|zip|phone|number|service|problem|urgency|time|day|preference)?\s*(?:is|to|was|:)?\s*(.+)$/i,
  );
  if (!match) return null;

  const aliases = {
    address: "location",
    zip: "location",
    number: "phone",
    problem: "service",
    time: "preference",
    day: "preference",
  };
  const rawField = String(match[1] || "").toLowerCase();
  const field = aliases[rawField] || rawField;
  const correctedValue = cleanVoiceText(match[2], 500);
  return correctedValue ? { field, value: correctedValue } : null;
};

export const normalizeUrgency = (value) => {
  const text = cleanVoiceText(value, 300).toLowerCase();
  if (/\b(?:emergency|immediate|right now|danger|unsafe|gas|fire|sparks|medical)\b/.test(text)) {
    return "emergency";
  }
  if (/\b(?:today|urgent|as soon as possible|asap|high|soon)\b/.test(text)) {
    return "high";
  }
  if (/\b(?:flexible|whenever|not urgent|low|no rush)\b/.test(text)) {
    return "low";
  }
  return "medium";
};

const NAME_PATTERN = /\b(?:my name is|this is|i am|i'm)\s+([a-z][a-z' -]{1,60})/i;
const LOCATION_PATTERN = /\b(?:at|address is|located at|location is)\s+([^,;.]{5,120})/i;
const PREFERENCE_PATTERN = /\b(?:(?:today|tomorrow)(?:\s+(?:morning|afternoon|evening|night))?|tonight|this (?:morning|afternoon|evening|weekend)|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\b/i;

export const extractCallbackDetails = (value, { currentField = "" } = {}) => {
  const text = cleanVoiceText(value, 1200);
  const result = {};
  const name = text.match(NAME_PATTERN)?.[1];
  const postalCode = extractPostalCode(text);
  const phone = extractPhoneNumber(text);
  const location = text.match(LOCATION_PATTERN)?.[1];
  const preference = text.match(PREFERENCE_PATTERN)?.[0];

  if (name) result.name = cleanVoiceText(name, 120);
  if (postalCode) result.location = postalCode;
  else if (location) result.location = cleanVoiceText(location, 500);
  if (phone) result.phone = phone;
  if (preference) result.preference = cleanVoiceText(preference, 300);
  if (/\b(?:urgent|asap|today|right now|emergency|flexible|no rush|not urgent)\b/i.test(text)) {
    result.urgency = normalizeUrgency(text);
    result.urgencyDetail = cleanVoiceText(text, 200);
  }

  const serviceLead = text
    .replace(NAME_PATTERN, "")
    .replace(LOCATION_PATTERN, "")
    .replace(PREFERENCE_PATTERN, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\b(?:need|want|looking for|help with|my name is|this is|i am|i'm)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    currentField === "service" ||
    /\b(?:leak|clog|drain|water heater|air conditioner|a\/?c|furnace|roof|electrical|plumbing|repair|install|replace|maintenance|inspection|broken|not working|no hot water|no heat|no cooling)\b/i.test(
      text,
    )
  ) {
    if (serviceLead.length >= 3) result.service = cleanVoiceText(serviceLead, 200);
  }

  return result;
};

export const isLikelyNonEnglish = (value) => {
  const text = cleanVoiceText(value, 500);
  if (!text) return false;
  if (EXPLICIT_LANGUAGE_PATTERN.test(text)) return true;

  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const tokens = normalized.match(/[a-z]+/g) || [];
  const markerCount = new Set(
    tokens.filter((token) => NON_ENGLISH_MARKERS.has(token)),
  ).size;
  if (markerCount >= 2) return true;

  const asciiLetters = text.match(/[A-Za-z]/g)?.length || 0;
  const nonAsciiLetters = text.match(/[^\x00-\x7F]/g)?.length || 0;
  return nonAsciiLetters >= 4 && nonAsciiLetters > asciiLetters / 2;
};

export const isTransientDependencyError = (error) => {
  const code = String(error?.code || error?.name || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    /TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|NETWORK|MONGO.*NETWORK|SERVERSELECTION/.test(
      code,
    ) ||
    /timed out|timeout|connection reset|temporarily unavailable|server selection|network error/.test(
      message,
    )
  );
};

export const sanitizeDtmfDigits = (value) => digitsOnly(value).slice(0, 20);

export default {
  cleanVoiceText,
  containsAbuse,
  extractCallbackDetails,
  extractPhoneNumber,
  extractPostalCode,
  formatClockTimeForSpeech,
  isBookingIntent,
  isBusinessHoursQuestion,
  isCallbackRequest,
  isCancelIntent,
  isHumanRequest,
  isLikelyNonEnglish,
  isNo,
  isRepeatIntent,
  isServiceAreaQuestion,
  isSkipIntent,
  isTransientDependencyError,
  isYes,
  normalizeUrgency,
  parseCorrection,
  sanitizeDtmfDigits,
  toSpokenReply,
};
