// Exact extracted availability recheck; preserves staff-exception and provider failure semantics.
export const createExactSlotAvailability = ({ AvailabilityService, withStaffSchedulingException, formatDateKey }) => async ({
  business,
  serviceOfferingId,
  startAt,
  endAt,
  postalCode,
  excludeAppointmentId,
  providerNameOverride = null,
  approvedExistingRequest = false,
}) => {
  const timeZone = business.timezone || "America/New_York";
  const dateKey = formatDateKey(startAt, timeZone);
  const lookup = () => AvailabilityService.getAvailability({
    business,
    forceFresh: true,
    serviceOfferingId,
    startDate: dateKey,
    endDate: dateKey,
    postalCode,
    excludeAppointmentId,
    providerNameOverride,
  });
  // The customer satisfied notice when requesting this exact time. A staff
  // decision must recheck current capacity, hours and calendar conflicts without
  // invalidating notice merely because time elapsed while awaiting approval.
  const result = approvedExistingRequest ? await withStaffSchedulingException({
    businessId: String(business._id), serviceOfferingId: String(serviceOfferingId), startAt,
    reason: 'Existing customer request: notice was checked when the slot was requested.',
  }, lookup) : await lookup();

  return result.slots.some(
    (slot) =>
      new Date(slot.startAt).getTime() === new Date(startAt).getTime() &&
      new Date(slot.endAt).getTime() === new Date(endAt).getTime(),
  );
};
