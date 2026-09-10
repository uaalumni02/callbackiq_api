export const staffReviewSlaMinutes = (priority = 'high') => {
  const key = priority === 'critical' ? 'EMERGENCY' : priority === 'high' ? 'URGENT' : 'HUMAN';
  const fallback = priority === 'critical' ? 5 : priority === 'high' ? 10 : 15;
  const raw = process.env[`STAFF_${key}_REVIEW_SLA_MINUTES`] ?? process.env[`SMS_${key}_CALLBACK_SLA_MINUTES`];
  const parsed = Number(raw);
  const minutes = Number.isFinite(parsed) && parsed >= 1 ? Math.min(240, parsed) : fallback;
  return minutes;
};

export const staffReviewDueAt = (priority = 'high', now = new Date()) =>
  new Date(new Date(now).getTime() + staffReviewSlaMinutes(priority) * 60_000);
