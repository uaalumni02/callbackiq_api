// Pure domain contracts. No network, DB, or model calls here.
export const RECOVERY_STATES = Object.freeze([
  'qualifying', 'needs_review', 'accepted', 'declined', 'scheduling', 'booked', 'closed',
]);
export const FACT_KEYS = Object.freeze(['customerName', 'serviceNeeded', 'address', 'preferredAppointmentTime']);
const trim = value => typeof value === 'string' ? value.trim() : '';
export const contractError = (message, code = 'RECOVERY_VALIDATION', statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });
export function validateFacts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw contractError('Facts must be an object.');
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !FACT_KEYS.includes(key))) throw contractError('Only reviewed customer facts may be changed.');
  const result = {};
  for (const key of keys) {
    if (typeof input[key] !== 'string' || !trim(input[key]) || trim(input[key]).length > (key === 'customerName' ? 120 : key === 'serviceNeeded' ? 200 : 500)) {
      throw contractError(`Invalid ${key}.`);
    }
    result[key] = trim(input[key]);
  }
  if (result.customerName && /^(missed call lead|new sms lead|unknown|customer)$/i.test(result.customerName)) throw contractError('An actual customer name is required.');
  return result;
}
export function validateDecision(input) {
  if (!input || !['accepted','declined'].includes(input.decision)) throw contractError('Explicit accept or decline is required.');
  const reason = trim(input.reason);
  if (reason.length < 15 || reason.length > 500) throw contractError('Supply a 15–500 character business review reason.');
  if (input.decision === 'accepted' && !/^[0-9a-f]{24}$/i.test(String(input.serviceOfferingId || ''))) throw contractError('Select an actual configured service offering.');
  return { decision: input.decision, reason, serviceOfferingId: input.decision === 'accepted' ? String(input.serviceOfferingId) : null };
}
export function requiredVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw contractError('A nonnegative integer version is required.');
  return value;
}
export function operationKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{12,128}$/.test(value)) throw contractError('A unique operation ID (12–128 safe characters) is required.');
  return value;
}
export const normalizeFacts = source => Object.fromEntries(FACT_KEYS.map(k=>[k, trim(source?.[k])]).filter(([,v])=>v));
export function nextReviewState(record, decision) {
  if (record.status === 'booked' || record.status === 'closed') throw contractError('A booked or closed request cannot be re-approved.', 'RECOVERY_TERMINAL', 409);
  if (record.status === 'declined') throw contractError('A declined request needs a new request generation.', 'RECOVERY_DECLINED', 409);
  return decision === 'accepted' ? 'accepted' : 'declined';
}
