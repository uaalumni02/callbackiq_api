/**
 * MeekCall Revenue Rescue V1 – deterministic decision policy.
 * No messages are transmitted by this module. In particular, unknown
 * permissions are NEVER interpreted as marketing consent.
 */
export const OPPORTUNITY_TYPES = Object.freeze([
  'missed_call', 'unsold_estimate', 'abandoned_booking',
  'customer_reactivation', 'cancellation_capacity', 'unpaid_invoice',
]);
export const STATUSES = Object.freeze([
  'open', 'claimed', 'contacted', 'booked', 'completed',
  'payment_recorded', 'lost', 'declined', 'closed',
]);
export const TERMINAL_STATUSES = Object.freeze(['payment_recorded', 'lost', 'declined', 'closed']);
export const TRANSITIONS = Object.freeze({
  open: ['claimed','contacted','booked','lost','declined','closed'],
  claimed: ['contacted','booked','lost','declined','closed'],
  contacted: ['booked','lost','declined','closed'],
  booked: ['completed','lost','closed'],
  completed: ['payment_recorded','closed'],
  payment_recorded: [], lost: [], declined: [], closed: [],
});
export function assertTransition(from, to) {
  if (!STATUSES.includes(to) || !TRANSITIONS[from]?.includes(to)) {
    const e = new Error(`Invalid opportunity transition: ${from} -> ${to}`);
    e.statusCode = 400; throw e;
  }
  return to;
}
export function moneyToCents(raw, name = 'amount') {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100000000 || !/^\d+(?:\.\d{1,2})?$/.test(String(raw))) {
    const e = new Error(`${name} must be a nonnegative dollar amount with at most two decimal places`);
    e.statusCode=400; throw e;
  }
  return Math.round(n * 100);
}
export function cleanString(x, max = 240) {
  return typeof x === 'string' ? x.trim().slice(0,max) : '';
}
export function validDueAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) { const e = new Error('Invalid dueAt'); e.statusCode=400; throw e; }
  return date;
}
export function suggestedAction(opp, now = new Date()) {
  if (TERMINAL_STATUSES.includes(opp.status)) return {kind:'none', reason:'Closed or declined'};
  if (['booked','completed'].includes(opp.status)) return {kind:'verify_outcome', reason:'Confirm completion and actual payment'};
  if (opp.contactPermission === 'opted_out') return {kind:'internal_review', reason:'Do not message: opted out'};
  if (opp.dueAt && new Date(opp.dueAt) <= now) return {kind:'human_rescue', reason:'Action deadline passed'};
  if (opp.status === 'open') return {kind:'claim', reason:'Assign a responsible team member'};
  if (opp.status === 'claimed') return {kind:'contact_review', reason:'Review contact permission and customer intent'};
  return {kind:'follow_through', reason:'Record the next verified step'};
}
export function canAutomateOutbound(opp) {
  // Marketing opt-in AND category-specific permission must be verified by an approved gateway.
  // Always false here: this add-on deliberately cannot generate uncontrolled SMS.
  return false;
}
export function normalizeType(value) {
  if (!OPPORTUNITY_TYPES.includes(value)) {
    const e = new Error('Invalid recovery opportunity type'); e.statusCode=400; throw e;
  }
  return value;
}
