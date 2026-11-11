const BLOCKED = new Set(['', 'anonymous', 'restricted', 'private', 'private number', 'blocked',
  'unknown', 'unavailable', '+266696687']);
export const phoneDigits = value => String(value || '').replace(/\D/g, '');
// Strict mode is for callable identities. Legacy mode preserves existing lookup keys.
export function canonicalPhone(value, { strict = true, defaultCountryCode = '1' } = {}) {
  const raw = String(value || '').trim();
  if (!raw || (strict && BLOCKED.has(raw.toLowerCase()))) return '';
  if (!strict && /^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  let digits = phoneDigits(raw);
  if (!digits) return strict ? '' : raw;
  const international = raw.startsWith('+') || (strict && digits.startsWith('00'));
  if (strict && digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && (!strict || !international)) digits = `${phoneDigits(defaultCountryCode)}${digits}`;
  if (!strict) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : raw;
  return /^[1-9]\d{7,14}$/.test(digits) && (international || digits.length >= 11) ? `+${digits}` : '';
}
