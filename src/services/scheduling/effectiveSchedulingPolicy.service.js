const finiteNonNegative = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export const effectiveSchedulingPolicy = (policy = {}, service = {}) => ({
  ...policy,
  minimumNoticeMinutes: finiteNonNegative(service?.minimumNoticeMinutesOverride)
    ?? finiteNonNegative(policy?.minimumNoticeMinutes) ?? 1440,
  allowSameDayBooking: service?.allowSameDayBookingOverride == null
    ? policy?.allowSameDayBooking === true : service.allowSameDayBookingOverride === true,
});
