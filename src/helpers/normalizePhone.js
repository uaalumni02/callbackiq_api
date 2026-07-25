const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export const normalizePhone = (value) => {
  const rawValue = String(value || "").trim();

  if (!rawValue) {
    return "";
  }

  if (E164_PATTERN.test(rawValue)) {
    return rawValue;
  }

  const digits = rawValue.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  /*
   * CallBackIQ currently serves U.S. home-service companies. Normalize
   * standard 10-digit U.S. numbers to +1 E.164 format.
   */
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  /*
   * Preserve other plausible international numbers in E.164-like form.
   * A dedicated phone-number library can replace this helper later.
   */
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }

  return rawValue;
};

export default normalizePhone;
