import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import Service from "../../src/models/serviceOffering.js";
import Rule from "../../src/models/availabilityRule.js";
import Policy from "../../src/models/schedulingPolicy.js";
import Area from "../../src/models/serviceArea.js";
import Connection from "../../src/models/integrationConnection.js";
import { encryptSecret } from "../../src/services/integrations/tokenEncryption.service.js";
import Google, {
  invalidateGoogleAvailabilityCache,
} from "../../src/integrations/scheduling/googleCalendar.provider.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
let originalFetch;
beforeAll(connectTestDB, 60000);
beforeEach(() => {
  originalFetch = global.fetch;
  process.env.GOOGLE_CALENDAR_REDIRECT_URI =
    "https://pilot.example.test/callback";
  process.env.OAUTH_STATE_SECRET = "pilot-state-secret-at-least-24-characters";
  process.env.INTEGRATION_ENCRYPTION_KEY =
    "pilot-encryption-key-with-at-least-32-characters";
});
afterEach(async () => {
  global.fetch = originalFetch;
  await clearTestDB();
});
afterAll(closeTestDB);
async function fixture() {
  const { business } = await stabilizationFixture();
  const service = await Service.create({
    business: business._id,
    name: "Repair",
    durationMinutes: 60,
    active: true,
    aiCanBook: true,
  });
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await Rule.create({
    business: business._id,
    dayOfWeek: new Date(date + "T12:00:00Z").getUTCDay(),
    enabled: true,
    windows: [{ startTime: "09:00", endTime: "17:00" }],
    capacity: 1,
  });
  await Policy.create({
    business: business._id,
    minimumNoticeMinutes: 0,
    allowSameDayBooking: true,
  });
  await Area.create({ business: business._id, type: "unrestricted" });
  await Connection.create({
    business: business._id,
    provider: "google_calendar",
    status: "connected",
    accessTokenEncrypted: encryptSecret("synthetic-token"),
    tokenExpiresAt: new Date(Date.now() + 3600000),
    providerCalendarId: "pilot-calendar",
    metadata: {
      googleCalendar: {
        bookingCalendarId: "pilot-calendar",
        availabilityCalendarIds: ["pilot-calendar"],
      },
    },
  });
  return {
    business,
    provider: new Google({ business }),
    date,
    options: { serviceOfferingId: service._id, startDate: date, endDate: date },
  };
}
const response = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});
const event = (date) => ({
  id: "owner-event",
  start: { dateTime: date + "T00:00:00Z" },
  end: { dateTime: date + "T23:59:59Z" },
});
test("B02 final recheck bypasses a previously clear cache after an external event appears", async () => {
  const { provider, date, options } = await fixture();
  let busy = false;
  global.fetch = jest.fn(async (url) =>
    response(
      String(url).endsWith("/freeBusy")
        ? { calendars: { "pilot-calendar": { busy: [] } } }
        : { items: busy ? [event(date)] : [] },
    ),
  );
  expect((await provider.getAvailability(options)).length).toBeGreaterThan(0);
  busy = true;
  expect(
    await provider.getAvailability({ ...options, forceFresh: true }),
  ).toEqual([]);
});
test("M04 a conflict on page two cannot disappear behind freeBusy fallback", async () => {
  const { provider, date, options } = await fixture();
  global.fetch = jest.fn(async (url) =>
    response(
      String(url).endsWith("/freeBusy")
        ? { calendars: { "pilot-calendar": { busy: [] } } }
        : String(url).includes("pageToken=next")
          ? { items: [event(date)] }
          : { items: [], nextPageToken: "next" },
    ),
  );
  expect(
    await provider.getAvailability({ ...options, forceFresh: true }),
  ).toEqual([]);
  expect(
    global.fetch.mock.calls.filter(([url]) => String(url).includes("/events?")),
  ).toHaveLength(2);
});
test("M04 incomplete or cyclic pagination fails closed", async () => {
  const { provider, options } = await fixture();
  global.fetch = jest.fn(async (url) =>
    response(
      String(url).endsWith("/freeBusy")
        ? { calendars: { "pilot-calendar": { busy: [] } } }
        : { items: [], nextPageToken: "loop" },
    ),
  );
  await expect(
    provider.getAvailability({ ...options, forceFresh: true }),
  ).rejects.toMatchObject({ code: "GOOGLE_AVAILABILITY_INCOMPLETE" });
});
test("B02 a shared epoch invalidates a cache populated by another process", async () => {
  const { business, provider, date, options } = await fixture();
  let busy = false;
  global.fetch = jest.fn(async (url) =>
    response(
      String(url).endsWith("/freeBusy")
        ? { calendars: { "pilot-calendar": { busy: [] } } }
        : { items: busy ? [event(date)] : [] },
    ),
  );
  expect((await provider.getAvailability(options)).length).toBeGreaterThan(0);
  busy = true;
  await Connection.updateOne(
    { business: business._id },
    { $inc: { availabilityCacheVersion: 1 } },
  );
  expect(await provider.getAvailability(options)).toEqual([]);
});
test("B02 an external conflict appearing before the provider write prevents event creation", async () => {
  const { business, provider, date } = await fixture();
  global.fetch = jest.fn(async (url) =>
    response(
      String(url).endsWith("/freeBusy")
        ? { calendars: { "pilot-calendar": { busy: [] } } }
        : { items: [event(date)] },
    ),
  );
  await expect(
    provider.createAppointment({
      appointment: {
        _id: "111111111111111111111111",
        business: business._id,
        startAt: date + "T14:00:00Z",
        endAt: date + "T15:00:00Z",
      },
      service: { name: "Repair" },
    }),
  ).rejects.toMatchObject({ code: "SLOT_NO_LONGER_AVAILABLE" });
  expect(
    global.fetch.mock.calls.some(
      ([url, options]) =>
        String(url).includes("/events?") && options.method === "POST",
    ),
  ).toBe(false);
});
