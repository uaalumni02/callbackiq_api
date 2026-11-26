import Appointment from "../../models/appointment.js";
import Connection from "../../models/integrationConnection.js";
import { ACTIVE_STATUSES } from "../../services/scheduling/appointmentStatePolicy.service.js";
import { googleApiRequest } from "../../services/integrations/googleCalendarConnection.service.js";
import { numericSetting } from "../../config/numericSettings.js";
import { zonedDateTimeToUtc } from "../../services/scheduling/timezone.service.js";
import { logOperationalError } from "../../helpers/logging/safeLogger.js";
const cache = new Map();
const incomplete = () =>
  Object.assign(
    new Error("Google availability could not be completely verified."),
    { code: "GOOGLE_AVAILABILITY_INCOMPLETE", statusCode: 409 },
  );
const eventBoundary = (field, timeZone) => {
  if (field?.dateTime) {
    if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(String(field.dateTime)))
      throw incomplete();
    return field.dateTime;
  }
  return field?.date
    ? zonedDateTimeToUtc({ dateKey: field.date, timeKey: "00:00", timeZone })
    : null;
};
/** Converts timed/all-day ranges in the calendar timezone; missing, invalid or reversed evidence rejects booking. */
export function googleEventRange(event, timeZone = "America/New_York") {
  const start = eventBoundary(event?.start, timeZone),
    end = eventBoundary(event?.end, timeZone);
  if (
    !start ||
    !end ||
    !Number.isFinite(new Date(start).getTime()) ||
    !Number.isFinite(new Date(end).getTime()) ||
    new Date(end) <= new Date(start)
  )
    throw incomplete();
  return { start, end };
}
const eventPages = async ({
  businessId,
  bookingCalendarId,
  timeMin,
  timeMax,
}) => {
  const items = [],
    seen = new Set();
  let pageToken, timeZone;
  for (
    let page = 0;
    page < numericSetting("PILOT_GOOGLE_EVENT_SCAN_PAGES");
    page++
  ) {
    const query = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "false",
      timeMin,
      timeMax,
      maxResults: "2500",
      ...(pageToken ? { pageToken } : {}),
    });
    const result = await googleApiRequest({
      businessId,
      path: `/calendars/${encodeURIComponent(bookingCalendarId)}/events?${query}`,
    });
    if (!Array.isArray(result?.items)) throw incomplete();
    items.push(...result.items);
    timeZone = result?.timeZone || timeZone;
    if (!result?.nextPageToken) return { items, complete: true, timeZone };
    if (seen.has(result.nextPageToken)) throw incomplete();
    seen.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  throw incomplete();
};
const externalEvents = async (businessId, items, timeZone) => {
  const events = items.filter(
    (event) =>
      event.status !== "cancelled" && event.transparency !== "transparent",
  );
  const ids = [
    ...new Set(
      events
        .map(
          (event) => event.extendedProperties?.private?.callbackiqAppointmentId,
        )
        .filter((id) => /^[a-f\d]{24}$/i.test(String(id))),
    ),
  ];
  const mirrored = ids.length
    ? new Set(
        (
          await Appointment.find({
            _id: { $in: ids },
            business: businessId,
            status: { $in: [...ACTIVE_STATUSES] },
          })
            .select("_id")
            .lean()
        ).map((row) => String(row._id)),
      )
    : new Set();
  return events.filter((event) => {
    const range = googleEventRange(event, timeZone);
    if (!range.start || !range.end) throw incomplete();
    const properties = event.extendedProperties?.private || {};
    return !(
      properties.callbackiqAppointmentId &&
      String(properties.callbackiqBusinessId || businessId) ===
        String(businessId) &&
      mirrored.has(String(properties.callbackiqAppointmentId))
    );
  });
};
const unlistedBusyRanges = (busy, events, timeZone) => {
  const ranges = events
    .filter(
      (event) =>
        event.status !== "cancelled" && event.transparency !== "transparent",
    )
    .map((event) => googleEventRange(event, timeZone))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  return busy.filter((range) => {
    let cursor = new Date(range.start).getTime();
    const end = new Date(range.end).getTime();
    if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor)
      throw incomplete();
    for (const known of ranges) {
      const start = new Date(known.start).getTime(),
        finish = new Date(known.end).getTime();
      if (finish <= cursor) continue;
      if (start > cursor) return true;
      cursor = Math.max(cursor, finish);
      if (cursor >= end) return false;
    }
    return true;
  });
};
const assertCompleteCalendars = (calendarResults, availabilityCalendarIds) => {
  for (const id of availabilityCalendarIds) {
    if (
      !calendarResults[id] ||
      calendarResults[id].errors?.length ||
      !Array.isArray(calendarResults[id].busy)
    )
      throw Object.assign(incomplete(), {
        code: "GOOGLE_AVAILABILITY_CALENDAR_ERROR",
      });
    for (const range of calendarResults[id].busy) {
      try {
        googleEventRange({
          start: { dateTime: range?.start },
          end: { dateTime: range?.end },
        });
      } catch {
        throw Object.assign(incomplete(), {
          code: "GOOGLE_AVAILABILITY_CALENDAR_ERROR",
        });
      }
    }
  }
};
const snapshotCacheKey = ({
  businessId,
  bookingCalendarId,
  availabilityCalendarIds,
  timeMin,
  timeMax,
  timeZone,
  epoch = 0,
}) =>
  [
    businessId,
    bookingCalendarId,
    timeZone,
    [...availabilityCalendarIds].sort().join(","),
    timeMin,
    timeMax,
    epoch,
  ].join("|");
/** Loads a complete snapshot; final checks bypass cache, while shared epochs invalidate other instances. */
export async function fetchGoogleAvailabilitySnapshot(options) {
  const {
    businessId,
    bookingCalendarId,
    availabilityCalendarIds,
    timeMin,
    timeMax,
    timeZone,
    forceFresh = false,
  } = options;
  const key = snapshotCacheKey(options);
  const previous = cache.get(key);
  if (!forceFresh && previous?.expiresAt > Date.now()) return previous.value;
  const [freeBusy, pages] = await Promise.all([
    googleApiRequest({
      businessId,
      path: "/freeBusy",
      method: "POST",
      body: {
        timeMin,
        timeMax,
        timeZone,
        items: availabilityCalendarIds.map((id) => ({ id })),
      },
    }),
    eventPages(options),
  ]);
  const calendarResults = freeBusy?.calendars || {};
  assertCompleteCalendars(calendarResults, availabilityCalendarIds);
  const calendarTimeZone = pages.timeZone || timeZone;
  const value = {
    calendarResults,
    externalBookingEvents: await externalEvents(
      businessId,
      pages.items,
      calendarTimeZone,
    ),
    unverifiedBookingBusy: unlistedBusyRanges(
      calendarResults[bookingCalendarId]?.busy || [],
      pages.items,
      calendarTimeZone,
    ),
    bookingEventsListed: pages.complete,
    calendarTimeZone,
  };
  cache.set(key, {
    value,
    expiresAt:
      Date.now() + numericSetting("PILOT_GOOGLE_AVAILABILITY_CACHE_MS"),
  });
  if (cache.size > 250) cache.delete(cache.keys().next().value);
  return value;
}
/** Clears local cache and advances the shared epoch; persistence failures are observable and never mask a provider receipt. */
export async function invalidateGoogleAvailabilityCache(businessId) {
  for (const key of cache.keys())
    if (key.startsWith(`${businessId}|`)) cache.delete(key);
  try {
    await Connection.updateOne(
      { business: businessId, provider: "google_calendar" },
      { $inc: { availabilityCacheVersion: 1 } },
    );
    return true;
  } catch (error) {
    logOperationalError("google.availability_invalidation_failed", error, {
      businessId,
    });
    return false;
  }
}
