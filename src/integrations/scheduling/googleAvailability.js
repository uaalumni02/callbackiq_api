import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";
import {
  fetchGoogleAvailabilitySnapshot,
  googleEventRange,
} from "./googleAvailabilitySnapshot.js";
const overlaps = (slot, range) =>
  new Date(slot.startAt) < new Date(range.end) &&
  new Date(slot.endAt) > new Date(range.start);
const fits = (
  slot,
  snapshot,
  options,
  bookingCalendarId,
  availabilityCalendarIds,
) => {
  const capacity = Math.max(
    0,
    Number(slot.remainingCapacity ?? slot.capacity ?? 1),
  );
  if (!capacity || snapshot.unverifiedBookingBusy?.some(range => overlaps(slot, range))) return false;
  const {
    calendarResults,
    externalBookingEvents,
    bookingEventsListed,
    calendarTimeZone,
  } = snapshot;
  const other = availabilityCalendarIds
    .filter((id) => id !== bookingCalendarId)
    .filter((id) =>
      calendarResults[id].busy.some((range) => overlaps(slot, range)),
    ).length;
  const booked = bookingEventsListed
    ? externalBookingEvents.filter(
        (event) =>
          event.id !== options.excludeExternalEventId &&
          overlaps(slot, googleEventRange(event, calendarTimeZone)),
      ).length
    : calendarResults[bookingCalendarId].busy.some((range) =>
          overlaps(slot, range),
        )
      ? capacity
      : 0;
  return other + booked < capacity;
};
/** Checks local capacity against complete Google evidence; forced freshness is used for final writes. */
export async function googleAvailability({
  business,
  options,
  normalizeSettings,
}) {
  const businessId = business._id || business.id;
  const { bookingCalendarId, availabilityCalendarIds, connection } = await normalizeSettings(businessId);
  const slots=await generateInternalSlots({...options,business});
  if(!Array.isArray(slots))throw Object.assign(new Error('Internal availability could not be verified.'),{code:'INVALID_AVAILABILITY_RESPONSE',statusCode:503});
  if(!slots.length)return [];
  const snapshot = await fetchGoogleAvailabilitySnapshot({
    businessId,
    bookingCalendarId,
    availabilityCalendarIds,
    timeMin: new Date(
      Math.min(...slots.map((slot) => new Date(slot.startAt).getTime())),
    ).toISOString(),
    timeMax: new Date(
      Math.max(...slots.map((slot) => new Date(slot.endAt).getTime())),
    ).toISOString(),
    timeZone: business.timezone || "America/New_York",
    epoch: connection.availabilityCacheVersion || 0,
    forceFresh: options.forceFresh === true,
  });
  return slots.filter((slot) =>
    fits(slot, snapshot, options, bookingCalendarId, availabilityCalendarIds),
  );
}
