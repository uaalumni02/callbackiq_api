// AvailabilityService owns business/service notice, same-day, hours and capacity
// policy. Consumers only discard stale/invalid options; holds recheck availability.
export const automatedSchedulingNotice = 'Appointments follow the business scheduling rules. Earlier or unavailable service needs direct team review.';
export const filterAutomatedSlots = (slots, now = new Date()) => {
  if (!Array.isArray(slots)) {
    const error = new Error('The scheduling provider returned invalid availability.');
    error.code = 'INVALID_AVAILABILITY_RESPONSE';
    throw error;
  }
  const cutoff = new Date(now).getTime();
  return slots.filter(slot => {
    const start = new Date(slot?.startAt).getTime(), end = new Date(slot?.endAt).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && start > cutoff && end > start;
  }).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
};
