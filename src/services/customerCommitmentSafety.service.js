// CALLBACKIQ_CUSTOMER_COMMITMENT_SAFETY_V1
// Shared customer-facing commitment guard used by both SMS and Voice AI.
//
// CallBackIQ may truthfully say that it saved, flagged, or sent a request when
// the corresponding durable operation has completed. It must not promise that
// staff will call, contact, arrive, or respond within an unverified timeframe.

const clean = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const ENGLISH_PROMISE_PATTERNS = [
  /\b(?:a |the )?(?:team member|team|staff|someone|a person|technician|dispatcher)\s+(?:will|'ll|is going to)\s+(?:call|contact|follow up|follow-up|reach out|get back to|respond to)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:we|they|someone|the team|staff)\s*(?:will|'ll)\s+(?:call|contact|follow up|reach out|get back to|respond)\b[^.!?]*(?:[.!?]|$)/gi,
  /\bexpect\s+(?:a |the )?(?:call|callback|contact|response|follow[- ]?up)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:call|contact|follow up|reach out|get back to)\s+(?:you|the number|at the confirmed number)\s+(?:shortly|soon|as soon as possible)\b[^.!?]*(?:[.!?]|$)/gi,
  /\bI(?:'ve| have) asked [^.!?]{0,80}\b(?:to call|to contact|to follow up|to reach out)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:the team|staff|we|they|[a-z0-9&' -]{2,80})\s+(?:will|'ll)\s+confirm\s+(?:availability|pricing|the cost|cost|the update|appointment details?)\b[^.!?]*(?:[.!?]|$)/gi,
  /\b(?:availability|pricing|the cost|cost|the update|appointment details?)\s+(?:will be|is going to be)\s+confirmed\b[^.!?]*(?:[.!?]|$)/gi,
];

const SPANISH_PROMISE_PATTERNS = [
  /\bel equipo se comunicar[aá][^.!?]*(?:[.!?]|$)/gi,
  /\bel equipo le devolver[aá] la llamada[^.!?]*(?:[.!?]|$)/gi,
  /\balguien le llamar[aá][^.!?]*(?:[.!?]|$)/gi,
  /\ble llamar[aá]n\b[^.!?]*(?:[.!?]|$)/gi,
];

const SAFE_ENGLISH = Object.freeze({
  sms:
    "I can't guarantee when someone will be available. I can keep helping here with the details and available options.",
  voice:
    "I can't guarantee when someone will be available. I can keep helping with the details and available options on this call.",
});

const SAFE_SPANISH =
  "No puedo garantizar cuándo habrá alguien disponible para llamar. Puedo seguir ayudando con los detalles.";

const MARKER_EN = "__CALLBACKIQ_SAFE_STAFF_COMMITMENT_EN__";
const MARKER_ES = "__CALLBACKIQ_SAFE_STAFF_COMMITMENT_ES__";

const collapseMarker = (text, marker, replacement) => {
  const repeated = new RegExp(`(?:\\s*${marker}\\s*)+`, "g");
  return text.replace(repeated, ` ${replacement} `);
};

export const hasUnverifiedStaffCommitment = (value) => {
  const text = clean(value);
  if (!text) return false;
  return (
    ENGLISH_PROMISE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    }) ||
    SPANISH_PROMISE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })
  );
};

export const sanitizeUnverifiedStaffCommitments = (
  value,
  { channel = "sms" } = {},
) => {
  let text = clean(value);
  if (!text) return "";

  for (const pattern of ENGLISH_PROMISE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, ` ${MARKER_EN} `);
  }
  for (const pattern of SPANISH_PROMISE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, ` ${MARKER_ES} `);
  }

  text = collapseMarker(
    text,
    MARKER_EN,
    SAFE_ENGLISH[channel] || SAFE_ENGLISH.sms,
  );
  text = collapseMarker(text, MARKER_ES, SAFE_SPANISH);
  return clean(text);
};

export default {
  hasUnverifiedStaffCommitment,
  sanitizeUnverifiedStaffCommitments,
};
