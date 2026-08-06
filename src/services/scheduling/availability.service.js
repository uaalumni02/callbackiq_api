import { validateServiceArea } from "./appointmentPolicy.service.js";
import {
  businessCalendarProviderName,
  normalizeCalendarProviderName,
} from "./calendarProviderName.service.js";
import SchedulingProviderFactory from "./schedulingProviderFactory.js";
import { formatZonedIso } from "./timezone.service.js";

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
    const serviceArea = await validateServiceArea({
      businessId,
      postalCode,
    });
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
      ...(excludeExternalEventId
        ? { excludeExternalEventId }
        : {}),
    };
    const slots = await provider.getAvailability(providerOptions);
    const timeZone = business.timezone || "America/New_York";

    return {
      supportedServiceArea: true,
      provider: providerName,
      serviceArea,
      slots: slots.map((slot) => ({
        ...slot,
        startAt: formatZonedIso(slot.startAt, timeZone),
        endAt: formatZonedIso(slot.endAt, timeZone),
      })),
    };
  }
}

export default AvailabilityService;
