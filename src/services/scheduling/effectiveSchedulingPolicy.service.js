import { currentStaffSchedulingException } from './staffSchedulingException.service.js';
const finiteNonNegative = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export const effectiveSchedulingPolicy = (policy = {}, service = {}, context = {}) => {
  const exception = currentStaffSchedulingException({ businessId: context.businessId,
    serviceOfferingId: service?._id, startAt: context.startAt });
  return ({
  ...policy,
  minimumNoticeMinutes: exception ? 0 : finiteNonNegative(service?.minimumNoticeMinutesOverride)
    ?? finiteNonNegative(policy?.minimumNoticeMinutes) ?? 1440,
  allowSameDayBooking: exception ? true : service?.allowSameDayBookingOverride == null
    ? policy?.allowSameDayBooking === true : service.allowSameDayBookingOverride === true,
});
};
