import normalizePhone from "../../helpers/normalizePhone.js";

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const US_E164_PATTERN = /^\+1\d{10}$/;
const DEFAULT_STOP_FOOTER = "Reply STOP to opt out.";
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 21;

const GSM_7_BASIC = new Set(
  [
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ",
    "ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?",
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ]
    .join("")
    .split(""),
);
const GSM_7_EXTENDED = new Set("^{}\\[~]|€".split(""));

const positiveInteger = (value, fallback, minimum = 1, maximum = 10000) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

export const normalizeSmsPhone = (value, { usOnly } = {}) => {
  const normalized = normalizePhone(value);
  const restrictToUs =
    typeof usOnly === "boolean"
      ? usOnly
      : String(process.env.SMS_US_ONLY || "true").toLowerCase() !== "false";

  if (!E164_PATTERN.test(normalized)) return "";
  if (restrictToUs && !US_E164_PATTERN.test(normalized)) return "";
  return normalized;
};

export const hasOptOutDisclosure = (body) => {
  const text = String(body || "");
  return /\breply\s+stop\b|\btext\s+stop\b|\bstop\s+to\s+(?:opt|unsubscribe)/i.test(
    text,
  );
};

export const ensureOptOutDisclosure = (
  body,
  { footer = DEFAULT_STOP_FOOTER } = {},
) => {
  const text = String(body || "").trim();
  if (!text || hasOptOutDisclosure(text)) return text;
  return `${text} ${footer}`.trim();
};

export const buildMissedCallRecoveryText = ({ business, template } = {}) => {
  const businessName = String(business?.businessName || "this business").trim();
  const fallback = `Hi, this is ${businessName}. Sorry we missed your call. What service do you need help with today?`;
  const rendered = String(template || business?.smsTemplate || fallback)
    .replaceAll("{{businessName}}", businessName)
    .trim();
  return ensureOptOutDisclosure(rendered || fallback);
};

const SOFT_OPT_OUT_PATTERNS = [
  /\bplease\s+stop(?:\s+(?:texting|messaging|contacting|sending\s+(?:me\s+)?messages?))?\b/i,
  /\bstop\s+(?:texting|messaging|contacting)\s+(?:me|this\s+number)\b/i,
  /\bdo\s+not\s+(?:text|message|contact)\s+(?:me|this\s+number)(?:\s+again)?\b/i,
  /\bdon['’]?t\s+(?:text|message|contact)\s+(?:me|this\s+number)(?:\s+again)?\b/i,
  /\b(?:remove|take)\s+(?:me|this\s+number)\s+(?:off|from)\s+(?:your\s+)?(?:list|messages?|texts?)\b/i,
  /\bopt\s*[- ]?out\b/i,
  /\bno\s+more\s+(?:texts?|messages?)\b/i,
  /\bquit\s+(?:texting|messaging)\s+(?:me|this\s+number)\b/i,
];

export const isSoftOptOutPhrase = (value) => {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/\b(?:do\s+not|don['’]?t|never)\s+stop\b/i.test(text)) return false;
  // CALLBACKIQ_SOFT_OPTOUT_QUESTION_GUARD
  // Asking how opt-out works is not itself an opt-out request.
  if (
    /\b(?:how|where|what|when)\b[^?]{0,60}\bopt\s*[- ]?out\b[^?]*\?/i.test(text) ||
    /\bhow\s+(?:do|can|would)\s+i\s+opt\s*[- ]?out\b/i.test(text)
  ) {
    return false;
  }
  return SOFT_OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
};

export const estimateSmsSegments = (body) => {
  const text = String(body || "");
  let septets = 0;
  let gsm7 = true;

  for (const character of text) {
    if (GSM_7_BASIC.has(character)) {
      septets += 1;
    } else if (GSM_7_EXTENDED.has(character)) {
      septets += 2;
    } else {
      gsm7 = false;
      break;
    }
  }

  if (gsm7) {
    return {
      encoding: "GSM-7",
      characterCount: text.length,
      encodedLength: septets,
      segmentCount: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }

  const codeUnits = [...text].reduce(
    (count, character) => count + (character.codePointAt(0) > 0xffff ? 2 : 1),
    0,
  );
  return {
    encoding: "UCS-2",
    characterCount: text.length,
    encodedLength: codeUnits,
    segmentCount: codeUnits <= 70 ? 1 : Math.ceil(codeUnits / 67),
  };
};

const getLocalHour = ({ now, timeZone }) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    return Number(parts.find((part) => part.type === "hour")?.value);
  } catch {
    return Number.NaN;
  }
};

export const evaluateSmsSendWindow = ({
  business,
  category = "scheduled",
  directResponse = false,
  bypassQuietHours = false,
  now = new Date(),
} = {}) => {
  const normalizedCategory = String(category || "scheduled").toLowerCase();
  const bypassCategories = new Set([
    "safety",
    "emergency",
    "compliance",
    "direct_response",
    "missed_call_recovery",
  ]);

  if (
    bypassQuietHours ||
    directResponse ||
    bypassCategories.has(normalizedCategory)
  ) {
    return { allowed: true, bypassed: true, reason: "responsive_or_safety" };
  }

  const startHour = positiveInteger(
    process.env.SMS_SEND_WINDOW_START_HOUR,
    DEFAULT_START_HOUR,
    0,
    23,
  );
  const endHour = positiveInteger(
    process.env.SMS_SEND_WINDOW_END_HOUR,
    DEFAULT_END_HOUR,
    1,
    24,
  );
  const timeZone = business?.timezone || "America/New_York";
  const localHour = getLocalHour({ now, timeZone });

  if (!Number.isFinite(localHour)) {
    return {
      allowed: false,
      reason: "recipient_local_time_unavailable",
      timeZone,
    };
  }

  const allowed =
    startHour < endHour
      ? localHour >= startHour && localHour < endHour
      : localHour >= startHour || localHour < endHour;

  return {
    allowed,
    reason: allowed ? "within_send_window" : "outside_send_window",
    localHour,
    startHour,
    endHour,
    timeZone,
  };
};

const CARD_NUMBER_PATTERN = /(?:\d[ -]*?){13,19}/;
const SSN_PATTERN = /\b\d{3}-?\d{2}-?\d{4}\b/;
const PASSWORD_PATTERN = /\b(?:password|passcode|pin|security\s+code)\s*[:=]\s*\S+/i;
const SUSPICIOUS_LINK_PATTERN =
  /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|rebrand\.ly|cutt\.ly)\b|https?:\/\/\S*(?:gift-?card|crypto|wire|payment|pay-now|login|verify-account)/i;

export const validateManualSmsBody = (body) => {
  const text = String(body || "").trim();
  if (!text) {
    return { allowed: false, reason: "empty_body", message: "Message text is required." };
  }
  if (text.length > 1600) {
    return {
      allowed: false,
      reason: "body_too_long",
      message: "Manual SMS messages cannot exceed 1,600 characters.",
    };
  }
  if (CARD_NUMBER_PATTERN.test(text) || SSN_PATTERN.test(text) || PASSWORD_PATTERN.test(text)) {
    return {
      allowed: false,
      reason: "sensitive_data",
      message: "Do not send payment-card, Social Security, password, PIN, or security-code data by SMS.",
    };
  }
  if (SUSPICIOUS_LINK_PATTERN.test(text)) {
    return {
      allowed: false,
      reason: "suspicious_link",
      message: "This message contains a blocked shortened or payment-related link.",
    };
  }

  const segment = estimateSmsSegments(text);
  const maxSegments = positiveInteger(process.env.MANUAL_SMS_MAX_SEGMENTS, 10, 1, 20);
  if (segment.segmentCount > maxSegments) {
    return {
      allowed: false,
      reason: "too_many_segments",
      message: `Manual SMS messages cannot exceed ${maxSegments} billed segments.`,
      segment,
    };
  }

  return { allowed: true, body: text, segment };
};

export { DEFAULT_STOP_FOOTER };
