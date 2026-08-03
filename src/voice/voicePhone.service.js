const BLOCKED_CALLER_IDS = new Set([
  "",
  "anonymous",
  "restricted",
  "private",
  "private number",
  "blocked",
  "unknown",
  "unavailable",
  "+266696687",
]);

export const digitsOnly = (value) => String(value || "").replace(/\D/g, "");

export const normalizePhoneToE164 = (value, { defaultCountryCode = "1" } = {}) => {
  const raw = String(value || "").trim();
  if (!raw || BLOCKED_CALLER_IDS.has(raw.toLowerCase())) return "";

  let digits = digitsOnly(raw);
  if (!digits) return "";

  const hadExplicitInternationalPrefix = raw.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (digits.length === 10 && !hadExplicitInternationalPrefix) {
    digits = `${digitsOnly(defaultCountryCode)}${digits}`;
  }

  // E.164 country codes never begin with zero. Reject placeholder, malformed,
  // and ambiguous short local values instead of treating them as callable.
  if (!/^[1-9]\d{7,14}$/.test(digits)) return "";
  if (!hadExplicitInternationalPrefix && digits.length < 11) return "";

  return `+${digits}`;
};

export const isUsableCallerId = (value) => Boolean(normalizePhoneToE164(value));

export const phoneNumbersEqual = (left, right) => {
  const normalizedLeft = normalizePhoneToE164(left);
  const normalizedRight = normalizePhoneToE164(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
};

export const phoneLookupVariants = (value) => {
  const e164 = normalizePhoneToE164(value);
  if (!e164) return [];

  const digits = e164.slice(1);
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const variants = new Set([e164, digits, national]);

  if (national.length === 10) {
    variants.add(`(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`);
    variants.add(`${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`);
    variants.add(`${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`);
  }

  return [...variants];
};

export const buildPhoneDigitsExpression = (field = "$phone") => ({
  $regexReplace: {
    input: { $ifNull: [field, ""] },
    regex: "[^0-9]",
    replacement: "",
  },
});

export const speakDigits = (value) =>
  digitsOnly(value)
    .split("")
    .join(" ");

export const maskPhone = (value) => {
  const normalized = normalizePhoneToE164(value);
  if (!normalized) return "unavailable";
  const digits = normalized.slice(1);
  return `+${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
};

export default {
  buildPhoneDigitsExpression,
  digitsOnly,
  isUsableCallerId,
  maskPhone,
  normalizePhoneToE164,
  phoneLookupVariants,
  phoneNumbersEqual,
  speakDigits,
};
