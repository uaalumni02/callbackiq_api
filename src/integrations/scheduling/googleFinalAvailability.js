import {
  fetchGoogleAvailabilitySnapshot,
  googleEventRange,
} from "./googleAvailabilitySnapshot.js";
const overlaps = (start, end, range) =>
  new Date(start) < new Date(range.end) &&
  new Date(end) > new Date(range.start);
/** Rechecks complete external evidence immediately before a write; any conflict or uncertainty rejects it. */
export async function assertGoogleWriteAvailable({
  business,
  appointment,
  bookingCalendarId,
  availabilityCalendarIds,
  connection,
}) {
  const snapshot = await fetchGoogleAvailabilitySnapshot({
    businessId: business._id || business.id,
    bookingCalendarId,
    availabilityCalendarIds: [
      ...new Set([...availabilityCalendarIds, bookingCalendarId]),
    ],
    timeMin: new Date(appointment.startAt).toISOString(),
    timeMax: new Date(appointment.endAt).toISOString(),
    timeZone: appointment.timezone || business.timezone || "America/New_York",
    epoch: connection.availabilityCacheVersion || 0,
    forceFresh: true,
  });
  const otherBusy = availabilityCalendarIds
    .filter((id) => id !== bookingCalendarId)
    .some((id) =>
      snapshot.calendarResults[id].busy.some((range) =>
        overlaps(appointment.startAt, appointment.endAt, range),
      ),
    );
  const bookingBusy = snapshot.bookingEventsListed
    ? snapshot.externalBookingEvents.some(
        (event) =>
          event.id !== appointment.externalAppointmentId &&
          overlaps(
            appointment.startAt,
            appointment.endAt,
            googleEventRange(event, snapshot.calendarTimeZone),
          ),
      )
    : snapshot.calendarResults[bookingCalendarId].busy.length > 0;
  const unverifiedBusy = snapshot.unverifiedBookingBusy?.some((range) =>
    overlaps(appointment.startAt, appointment.endAt, range),
  );
  if (otherBusy || bookingBusy || unverifiedBusy)
    throw Object.assign(
      new Error("This time is no longer available. Choose another time."),
      {
        code: "SLOT_NO_LONGER_AVAILABLE",
        statusCode: 409,
        confirmationCreateRejected: true,
      },
    );
}
