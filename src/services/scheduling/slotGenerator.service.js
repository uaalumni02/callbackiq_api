import { dateWindows, shiftDate } from './availabilityWindows.service.js';
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
    startAt: { $lt: addMinutes(queryEnd, 1440) },
    endAt: { $gt: addMinutes(queryStart, -1440) },
    $or: [
      { status: "confirmed" },
      { status: "held", heldExpiresAt: { $gt: now } },
    ],
  };

  if (excludeAppointmentId) {
    appointmentQuery._id = { $ne: excludeAppointmentId };
  }

  const appointments = await Appointment.find(appointmentQuery).lean();
  const slots = [];

  for (const dateKey of dateKeys) {
    const rule = rules.find(r => Number(r.dayOfWeek) === getUtcDayOfWeekForDateKey(dateKey));
    const exception = exceptions.find(e => e.date === dateKey && e.type === 'special_hours' && e.appliesTo !== 'answering');
    const windows = dateWindows({ dateKey, rules, exceptions, emergencyEligible: service.emergencyEligible });
    const tomorrow = dateWindows({ dateKey: shiftDate(dateKey, 1), rules, exceptions, emergencyEligible: service.emergencyEligible });
    const capacity = Number(exception?.capacity || rule?.capacity || 1);
    const atMinute = minute => zonedDateTimeToUtc({ dateKey: shiftDate(dateKey, Math.floor(minute / 1440)), timeKey: timeKeyFromMinutes(minute % 1440), timeZone });
    for (const [windowStartMinutes, close] of windows) {
      const windowEndMinutes = close === 1440 && tomorrow[0]?.[0] === 0 ? 1440 + tomorrow[0][1] : close;
      for (
        let cursor = windowStartMinutes;
        cursor < 1440 && cursor + durationMinutes <= windowEndMinutes;
        cursor += intervalMinutes
      ) {
        let startAt;
        try { startAt = atMinute(cursor); } catch (error) {
          // A nonexistent DST wall time must never become a different appointment.
          if (/nonexistent|does not exist|daylight|local time/i.test(error.message)) continue;
          throw error;
        }
        const endAt = addMinutes(startAt, durationMinutes);
        const bufferedStartAt = addMinutes(startAt, -bufferBeforeMinutes);
        const bufferedEndAt = addMinutes(endAt, bufferAfterMinutes);

        try {
          validateBookingWindow({ startAt, policy: effectiveSchedulingPolicy(policy, service, { businessId, startAt }), now, timeZone });
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
