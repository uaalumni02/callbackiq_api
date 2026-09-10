// Automated offers and holds require 24 elapsed hours of notice, regardless of shorter catalog overrides.
export const AUTOMATED_NOTICE_MS = 24 * 60 * 60 * 1000;
export const automatedSchedulingNotice = 'Automated appointment requests require at least 24 hours of notice. Earlier service needs direct team review.';
export const filterAutomatedSlots = (slots, now = new Date()) => {
  if (!Array.isArray(slots)) {
    const error = new Error('The scheduling provider returned invalid availability.');
    error.code = 'INVALID_AVAILABILITY_RESPONSE';
    throw error;
  }
  const cutoff = new Date(now).getTime() + AUTOMATED_NOTICE_MS;
  return slots.filter(slot => {
    const start = new Date(slot?.startAt).getTime(), end = new Date(slot?.endAt).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && start >= cutoff && end > start;
  }).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
};
export const assertAutomatedNotice = (startAt, now = new Date()) => {
  const start = new Date(startAt).getTime();
  if (!Number.isFinite(start) || start < new Date(now).getTime() + AUTOMATED_NOTICE_MS) {
    const error = new Error(automatedSchedulingNotice);
    error.code = 'MINIMUM_NOTICE_NOT_MET'; error.statusCode = 409;
    throw error;
  }
};
