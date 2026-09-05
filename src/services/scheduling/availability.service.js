import ServiceOffering from "../../models/serviceOffering.js";
import {
  getSchedulingPolicy,
  validateServiceArea,
} from "./appointmentPolicy.service.js";
import {
  businessCalendarProviderName,
  normalizeCalendarProviderName,
} from "./calendarProviderName.service.js";
import SchedulingProviderFactory from "./schedulingProviderFactory.js";
import { formatDateKey, formatZonedIso } from "./timezone.service.js";

const finiteNonNegative = (value) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

class AvailabilityService {
  static async getAvailability({
    business,
    serviceOfferingId,
    startDate,
    endDate,
    postalCode,
    excludeAppointmentId = null,
    providerNameOverride = null,
    excludeExternalEventId = null,
  }) {
    const businessId = business._id || business.id;
    const [serviceArea, policy, service] = await Promise.all([
      validateServiceArea({ businessId, postalCode }),
      getSchedulingPolicy(businessId),
      ServiceOffering.findOne({
        _id: serviceOfferingId,
        business: businessId,
        active: true,
      }).lean(),
    ]);

    const providerName = providerNameOverride
      ? normalizeCalendarProviderName(providerNameOverride)
      : businessCalendarProviderName(business);

    if (!serviceArea.supported) {
      return {
        supportedServiceArea: false,
        reason: serviceArea.reason,
        provider: providerName,
        slots: [],
      };
    }

    const serviceNoticeOverride = finiteNonNegative(
      service?.minimumNoticeMinutesOverride,
    );
    const minimumNoticeMinutes =
      serviceNoticeOverride ??
      finiteNonNegative(policy?.minimumNoticeMinutes) ??
      1440;
    const allowSameDayBooking =
      service?.allowSameDayBookingOverride == null
        ? policy?.allowSameDayBooking === true
        : service.allowSameDayBookingOverride === true;

    const provider = SchedulingProviderFactory.getProvider(
      business,
      providerNameOverride,
    );
    const providerOptions = {
      serviceOfferingId,
      startDate,
      endDate,
      postalCode,
      excludeAppointmentId,
      ...(excludeExternalEventId ? { excludeExternalEventId } : {}),
    };
    const slots = await provider.getAvailability(providerOptions);
    const timeZone = business.timezone || "America/New_York";
    const now = new Date();
    const earliestCustomerFacingStart = new Date(
      now.getTime() + minimumNoticeMinutes * 60_000,
    );
    const todayKey = formatDateKey(now, timeZone);

    const policySafeSlots = (Array.isArray(slots) ? slots : [])
      .filter((slot) => {
        const startAt = new Date(slot.startAt);
        if (Number.isNaN(startAt.getTime())) return false;
        if (startAt < earliestCustomerFacingStart) return false;
        if (
          !allowSameDayBooking &&
          formatDateKey(startAt, timeZone) === todayKey
        ) {
          return false;
        }
        return true;
      })
      .sort(
        (left, right) =>
          new Date(left.startAt).getTime() - new Date(right.startAt).getTime(),
      );

    return {
      supportedServiceArea: true,
      provider: providerName,
      serviceArea,
      minimumNoticeMinutes,
      allowSameDayBooking,
      slots: policySafeSlots.map((slot) => ({
        ...slot,
        startAt: formatZonedIso(slot.startAt, timeZone),
        endAt: formatZonedIso(slot.endAt, timeZone),
      })),
    };
  }
}

export default AvailabilityService;
