import { canonicalPhone, phoneDigits } from '../helpers/phoneIdentity.js';
export const digitsOnly = phoneDigits;
export const normalizePhoneToE164 = (value, options) => canonicalPhone(value, options);

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
