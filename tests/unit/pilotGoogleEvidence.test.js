import Appointment from "../../src/models/appointment.js";
import Connection from "../../src/models/integrationConnection.js";
import { googleApiRequest } from "../../src/services/integrations/googleCalendarConnection.service.js";
import {
  fetchGoogleAvailabilitySnapshot,
  googleEventRange,
  invalidateGoogleAvailabilityCache,
} from "../../src/integrations/scheduling/googleAvailabilitySnapshot.js";
jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));
jest.mock("../../src/models/integrationConnection.js", () => ({
  __esModule: true,
  default: { updateOne: jest.fn() },
}));
jest.mock(
  "../../src/services/integrations/googleCalendarConnection.service.js",
  () => ({ googleApiRequest: jest.fn() }),
);
let sequence = 0;
const options = () => ({
  businessId: `synthetic-${++sequence}`,
  bookingCalendarId: "cal",
  availabilityCalendarIds: ["cal"],
  timeMin: "2026-03-08T05:00:00Z",
  timeMax: "2026-03-09T04:00:00Z",
  timeZone: "America/New_York",
  forceFresh: true,
});
beforeEach(() => {
  jest.clearAllMocks();
  Appointment.find.mockReturnValue({
    select: () => ({ lean: async () => [] }),
  });
  Connection.updateOne.mockResolvedValue({ modifiedCount: 1 });
  googleApiRequest.mockImplementation(async ({ path }) =>
    path === "/freeBusy"
      ? { calendars: { cal: { busy: [] } } }
      : { items: [], timeZone: "America/New_York" },
  );
});
test.each([{}, { items: {} }, { items: null }])(
  "B02/M04 incomplete event-list evidence rejects booking: %p",
  async (page) => {
    googleApiRequest.mockImplementation(async ({ path }) =>
      path === "/freeBusy" ? { calendars: { cal: { busy: [] } } } : page,
    );
    await expect(
      fetchGoogleAvailabilitySnapshot(options()),
    ).rejects.toMatchObject({ code: "GOOGLE_AVAILABILITY_INCOMPLETE" });
  },
);
test.each([
  { start: { dateTime: "garbled" }, end: { dateTime: "also garbled" } },
  {
    start: { dateTime: "2026-03-08T07:00:00Z" },
    end: { dateTime: "2026-03-08T06:00:00Z" },
  },
  {
    start: { dateTime: "2026-03-08T07:00:00" },
    end: { dateTime: "2026-03-08T08:00:00" },
  },
  {},
])("B02 malformed external event time cannot become a free slot: %p", (event) =>
  expect(() => googleEventRange(event, "America/New_York")).toThrow(),
);
test("B02 all-day events span the real DST calendar day", () => {
  const range = googleEventRange(
    { start: { date: "2026-03-08" }, end: { date: "2026-03-09" } },
    "America/New_York",
  );
  expect(new Date(range.start).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  expect(new Date(range.end).toISOString()).toBe("2026-03-09T04:00:00.000Z");
});
test("B02 external metadata cannot disguise another tenant or a non-mirrored event", async () => {
  const o = options(),
    id = "aaaaaaaaaaaaaaaaaaaaaaaa";
  Appointment.find.mockReturnValue({
    select: () => ({ lean: async () => [{ _id: id }] }),
  });
  const timed = {
    start: { dateTime: "2026-03-08T06:00:00Z" },
    end: { dateTime: "2026-03-08T07:00:00Z" },
  };
  googleApiRequest.mockImplementation(async ({ path }) =>
    path === "/freeBusy"
      ? { calendars: { cal: { busy: [] } } }
      : {
          items: [
            {
              id: "own",
              ...timed,
              extendedProperties: {
                private: {
                  callbackiqAppointmentId: id,
                  callbackiqBusinessId: o.businessId,
                },
              },
            },
            {
              id: "foreign",
              ...timed,
              extendedProperties: {
                private: {
                  callbackiqAppointmentId: id,
                  callbackiqBusinessId: "other-tenant",
                },
              },
            },
            { id: "external", ...timed },
            { id: "cancelled", status: "cancelled" },
            { id: "transparent", transparency: "transparent" },
          ],
        },
  );
  const result = await fetchGoogleAvailabilitySnapshot(o);
  expect(result.externalBookingEvents.map((e) => e.id)).toEqual([
    "foreign",
    "external",
  ]);
  expect(Appointment.find).toHaveBeenCalledWith(
    expect.objectContaining({ business: o.businessId }),
  );
});
test.each([
  {},
  { cal: { errors: [{ reason: "notFound" }] } },
  { cal: { busy: null } },
])("B02 freeBusy evidence fails closed: %p", (calendars) => {
  googleApiRequest.mockImplementation(async ({ path }) =>
    path === "/freeBusy" ? { calendars } : { items: [] },
  );
  return expect(
    fetchGoogleAvailabilitySnapshot(options()),
  ).rejects.toMatchObject({ code: "GOOGLE_AVAILABILITY_CALENDAR_ERROR" });
});
test("M04 a provider with endless unique pages reaches the configured bound", async () => {
  let pages = 0;
  googleApiRequest.mockImplementation(async ({ path }) =>
    path === "/freeBusy"
      ? { calendars: { cal: { busy: [] } } }
      : { items: [], nextPageToken: `page-${++pages}` },
  );
  await expect(
    fetchGoogleAvailabilitySnapshot(options()),
  ).rejects.toMatchObject({ code: "GOOGLE_AVAILABILITY_INCOMPLETE" });
  expect(pages).toBe(10);
});
test("B02 cache invalidation is tenant scoped and database failure is observable", async () => {
  const a = { ...options(), forceFresh: false },
    b = { ...options(), forceFresh: false };
  await fetchGoogleAvailabilitySnapshot(a);
  await fetchGoogleAvailabilitySnapshot(b);
  await fetchGoogleAvailabilitySnapshot(a);
  expect(googleApiRequest).toHaveBeenCalledTimes(4);
  expect(await invalidateGoogleAvailabilityCache(a.businessId)).toBe(true);
  await fetchGoogleAvailabilitySnapshot(a);
  await fetchGoogleAvailabilitySnapshot(b);
  expect(googleApiRequest).toHaveBeenCalledTimes(6);
  Connection.updateOne.mockRejectedValue(
    new Error("synthetic database unavailable"),
  );
  expect(await invalidateGoogleAvailabilityCache(a.businessId)).toBe(false);
});
test.each([
  [[], 1],
  [[["06:00", "08:00"]], 0],
  [[["06:00", "07:00"]], 1],
  [
    [
      ["06:00", "07:00"],
      ["07:00", "08:00"],
    ],
    0,
  ],
  [
    [
      ["06:00", "06:30"],
      ["07:00", "08:00"],
    ],
    1,
  ],
  [
    [
      ["04:00", "05:00"],
      ["06:00", "08:00"],
    ],
    0,
  ],
])(
  "B02 freeBusy evidence missing from the event listing remains blocked: %p",
  async (spans, expected) => {
    const at = (time) => `2026-03-08T${time}:00Z`;
    googleApiRequest.mockImplementation(async ({ path }) =>
      path === "/freeBusy"
        ? {
            calendars: {
              cal: { busy: [{ start: at("06:00"), end: at("08:00") }] },
            },
          }
        : {
            items: spans.map(([start, end], i) => ({
              id: `external-${i}`,
              start: { dateTime: at(start) },
              end: { dateTime: at(end) },
            })),
          },
    );
    expect(
      (await fetchGoogleAvailabilitySnapshot(options())).unverifiedBookingBusy,
    ).toHaveLength(expected);
  },
);
test("B02 malformed busy evidence on a secondary calendar is never interpreted as a free slot", async () => {
  googleApiRequest.mockImplementation(async ({ path }) =>
    path === "/freeBusy"
      ? {
          calendars: {
            cal: { busy: [] },
            secondary: { busy: [{ start: "garbled", end: "garbled" }] },
          },
        }
      : { items: [] },
  );
  await expect(
    fetchGoogleAvailabilitySnapshot({
      ...options(),
      availabilityCalendarIds: ["cal", "secondary"],
    }),
  ).rejects.toMatchObject({ code: "GOOGLE_AVAILABILITY_CALENDAR_ERROR" });
});
test("B02 bounded preview cache evicts older tenants and keeps the latest snapshot", async () => {
  const all = Array.from({ length: 260 }, () => ({
    ...options(),
    forceFresh: false,
  }));
  for (const o of all) await fetchGoogleAvailabilitySnapshot(o);
  expect(googleApiRequest).toHaveBeenCalledTimes(520);
  await fetchGoogleAvailabilitySnapshot(all[0]);
  expect(googleApiRequest).toHaveBeenCalledTimes(522);
  await fetchGoogleAvailabilitySnapshot(all.at(-1));
  expect(googleApiRequest).toHaveBeenCalledTimes(522);
});
