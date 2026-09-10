import { effectiveSchedulingPolicy } from "./effectiveSchedulingPolicy.service.js";
import Appointment from "../../models/appointment.js";
import AvailabilityException from "../../models/availabilityException.js";
import AvailabilityRule from "../../models/availabilityRule.js";
import {
  addMinutes,
  enumerateDateKeys,
  getUtcDayOfWeekForDateKey,
  minutesFromTimeKey,
  timeKeyFromMinutes,
  zonedDateTimeToUtc,
} from "./timezone.service.js";
import {
  getBookableService,
  getSchedulingPolicy,
  validateBookingWindow,
} from "./appointmentPolicy.service.js";

const overlaps = (firstStart, firstEnd, secondStart, secondEnd) =>
  firstStart < secondEnd && firstEnd > secondStart;

const normalizeWindows = (windows = []) =>
  (Array.isArray(windows) ? windows : [])
    .map((window) => ({
      startTime: String(window?.startTime || "").trim(),
      endTime: String(window?.endTime || "").trim(),
    }))
    .filter((window) => window.startTime && window.endTime);

const getDateWindows = ({ rule, exception, service }) => {
  const closedTypes = new Set([
    "holiday",
    "closure",
    "fully_booked",
    "technician_meeting",
  ]);

  if (closedTypes.has(exception?.type)) {
    return [];
  }

  if (exception?.type === "emergency_only" && !service?.emergencyEligible) {
    return [];
  }

  if (exception?.type === "special_hours" || exception?.allDay === false) {
    return normalizeWindows(exception.windows);
  }

  if (!rule?.enabled) {
    return [];
  }

  return normalizeWindows(rule.windows);
};

const getExceptionDateKey = (exception) => {
  const value = String(exception?.date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
};

const appointmentBlocksSlot = ({ appointment, startAt, endAt }) => {
  const busyStart = addMinutes(
    appointment.startAt,
    -Number(appointment.bufferBeforeMinutes || 0),
  );
  const busyEnd = addMinutes(
    appointment.endAt,
    Number(appointment.bufferAfterMinutes || 0),
  );

  return overlaps(startAt, endAt, busyStart, busyEnd);
};

export const generateInternalSlots = async ({
  business,
  serviceOfferingId,
  startDate,
  endDate,
  excludeAppointmentId = null,
  now = new Date(),
}) => {
  const businessId = business._id || business.id;
  const timeZone = business.timezone || "America/New_York";
  const [service, policy, rules, exceptions] = await Promise.all([
    getBookableService({ businessId, serviceOfferingId }),
    getSchedulingPolicy(businessId),
    AvailabilityRule.find({ business: businessId }).lean(),
    AvailabilityException.find({
      business: businessId,
      active: { $ne: false },
    }).lean(),
  ]);

  const dateKeys = enumerateDateKeys(startDate, endDate);
  const durationMinutes = Number(
    service.durationMinutes || policy.defaultDurationMinutes || 90,
  );
  const bufferBeforeMinutes = Number(service.bufferBeforeMinutes || 0);
  const bufferAfterMinutes = Number(service.bufferAfterMinutes || 0);
  const intervalMinutes = Number(policy.slotIntervalMinutes || 30);

  const queryStart = zonedDateTimeToUtc({
    dateKey: startDate,
    timeKey: "00:00",
    timeZone,
  });
  const queryEnd = addMinutes(
    zonedDateTimeToUtc({ dateKey: endDate, timeKey: "23:59", timeZone }),
    1,
  );

  const appointmentQuery = {
    business: businessId,
    status: { $in: ["held", "confirmed"] },
    startAt: { $lt: queryEnd },
    endAt: { $gt: queryStart },
    $or: [
      { status: "confirmed" },
      { status: "held", heldExpiresAt: { $gt: now } },
    ],
  };

  if (excludeAppointmentId) {
    appointmentQuery._id = { $ne: excludeAppointmentId };
  }

  const appointments = await Appointment.find(appointmentQuery).lean();
  const rulesByDay = new Map(rules.map((rule) => [Number(rule.dayOfWeek), rule]));
  const exceptionsByDate = new Map(
    exceptions
      .map((exception) => [getExceptionDateKey(exception), exception])
      .filter(([dateKey]) => Boolean(dateKey)),
  );
  const slots = [];

  for (const dateKey of dateKeys) {
    const dayOfWeek = getUtcDayOfWeekForDateKey(dateKey);
    const rule = rulesByDay.get(dayOfWeek);
    const exception = exceptionsByDate.get(dateKey);
    const windows = getDateWindows({ rule, exception, service });
    const capacity = Number(exception?.capacity || rule?.capacity || 1);

    for (const window of windows) {
      const windowStartMinutes = minutesFromTimeKey(window.startTime);
      const windowEndMinutes = minutesFromTimeKey(window.endTime);

      for (
        let cursor = windowStartMinutes;
        cursor + durationMinutes <= windowEndMinutes;
        cursor += intervalMinutes
      ) {
        const startAt = zonedDateTimeToUtc({
          dateKey,
          timeKey: timeKeyFromMinutes(cursor),
          timeZone,
        });
        const endAt = addMinutes(startAt, durationMinutes);
        const bufferedStartAt = addMinutes(startAt, -bufferBeforeMinutes);
        const bufferedEndAt = addMinutes(endAt, bufferAfterMinutes);

        try {
          validateBookingWindow({ startAt, policy: effectiveSchedulingPolicy(policy, service), now, timeZone });
        } catch (error) {
          if (["SAME_DAY_BOOKING_DISABLED", "MINIMUM_NOTICE_NOT_MET", "MAXIMUM_ADVANCE_EXCEEDED"].includes(error.code)) {
            continue;
          }
          throw error;
        }

        const overlappingCount = appointments.filter((appointment) =>
          appointmentBlocksSlot({
            appointment,
            startAt: bufferedStartAt,
            endAt: bufferedEndAt,
          }),
        ).length;

        if (overlappingCount >= capacity) {
          continue;
        }

        const slot = {
          startAt,
          endAt,
          timezone: timeZone,
          bufferBeforeMinutes,
          bufferAfterMinutes,
          serviceOfferingId: String(service._id),
        };

        // Capacity is provider-internal metadata. Keep it directly readable by
        // GoogleCalendarProvider without changing the long-standing public slot
        // response shape used by API clients and legacy tests.
        Object.defineProperties(slot, {
          capacity: { value: capacity, enumerable: false },
          internalOverlappingCount: {
            value: overlappingCount,
            enumerable: false,
          },
          remainingCapacity: {
            value: Math.max(0, capacity - overlappingCount),
            enumerable: false,
          },
        });

        slots.push(slot);
      }
    }
  }

  return slots;
};

export default generateInternalSlots;
