import { effectiveSchedulingPolicy } from "./effectiveSchedulingPolicy.service.js";
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

    if (serviceArea.supported == null) {
      throw Object.assign(new Error('The service area needs staff review before checking availability.'), {
        code: 'SERVICE_AREA_REVIEW_REQUIRED', statusCode: 409, serviceArea,
      });
    }
    if (serviceArea.supported !== true) {
      return {
        supportedServiceArea: false,
        reason: serviceArea.reason,
        provider: providerName,
        slots: [],
      };
    }

    const { minimumNoticeMinutes, allowSameDayBooking } = effectiveSchedulingPolicy(policy, service);

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
    if (!Array.isArray(slots)) {
      const error = new Error('Scheduling provider returned an invalid slot list.');
      error.code = 'INVALID_AVAILABILITY_RESPONSE';
      throw error;
    }
    const timeZone = business.timezone || "America/New_York";
    const now = new Date();
    const todayKey = formatDateKey(now, timeZone);

    const policySafeSlots = (Array.isArray(slots) ? slots : [])
      .filter((slot) => {
        const startAt = new Date(slot.startAt);
        if (Number.isNaN(startAt.getTime())) return false;
        const endAt = new Date(slot.endAt);
        if (!Number.isFinite(endAt.getTime()) || endAt <= startAt) return false;
        const slotPolicy = effectiveSchedulingPolicy(policy, service, { businessId, startAt });
        if (startAt <= now || startAt < new Date(now.getTime() + slotPolicy.minimumNoticeMinutes * 60_000)) return false;
        if (
          !slotPolicy.allowSameDayBooking &&
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
