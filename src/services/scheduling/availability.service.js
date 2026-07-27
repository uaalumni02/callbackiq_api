import SchedulingProviderFactory from "./schedulingProviderFactory.js";
import { formatZonedIso } from "./timezone.service.js";
import { validateServiceArea } from "./appointmentPolicy.service.js";

class AvailabilityService {
  static async getAvailability({
    business,
    serviceOfferingId,
    startDate,
    endDate,
    postalCode,
    excludeAppointmentId = null,
  }) {
    const businessId = business._id || business.id;
    const area = await validateServiceArea({ businessId, postalCode });

    if (!area.supported) {
      return {
        supportedServiceArea: false,
        reason: area.reason,
        provider:
          business?.features?.calendarProvider ||
          business?.featureSettings?.calendarProvider ||
          "internal",
        slots: [],
      };
    }

    const provider = SchedulingProviderFactory.getProvider(business);
    const slots = await provider.getAvailability({
      serviceOfferingId,
      startDate,
      endDate,
      postalCode,
      excludeAppointmentId,
    });
    const timeZone = business.timezone || "America/New_York";

    return {
      supportedServiceArea: true,
      provider:
        business?.features?.calendarProvider ||
        business?.featureSettings?.calendarProvider ||
        "internal",
      slots: slots.map((slot) => ({
        ...slot,
        startAt: formatZonedIso(slot.startAt, timeZone),
        endAt: formatZonedIso(slot.endAt, timeZone),
      })),
    };
  }
}

export default AvailabilityService;
