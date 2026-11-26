import ConnectionModel from '../../src/models/integrationConnection.js';
import GoogleCalendarProvider from "../../src/integrations/scheduling/googleCalendar.provider.js";
import { generateInternalSlots } from "../../src/services/scheduling/slotGenerator.service.js";
import {
  getGoogleConnection,
  googleApiRequest,
} from "../../src/services/integrations/googleCalendarConnection.service.js";

jest.mock("../../src/services/scheduling/slotGenerator.service.js", () => ({
  __esModule: true,
  generateInternalSlots: jest.fn(),
}));
jest.mock("../../src/services/integrations/googleCalendarConnection.service.js", () => ({
  __esModule: true,
  getGoogleConnection: jest.fn(),
  googleApiRequest: jest.fn(),
}));

const allowCalendarWrites=payload=>googleApiRequest.mockImplementation(async({path,method,body})=>{
 if(path==='/freeBusy')return {calendars:Object.fromEntries(body.items.map(({id})=>[id,{busy:[]}]))};
 if((!method || method==='GET') && path.includes('/events?'))return {items:[]};return payload;
});
describe("GoogleCalendarProvider", () => {
  const business = { _id: "b1", timezone: "America/New_York" };
  let provider;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(ConnectionModel,"updateOne").mockResolvedValue({modifiedCount:1});
    provider = new GoogleCalendarProvider({ business });
    getGoogleConnection.mockResolvedValue({ providerCalendarId: "calendar@example.com" });
  });

  test("requires a selected calendar", async () => {
    getGoogleConnection.mockResolvedValue({ providerCalendarId: "" });
    await expect(provider.getAvailability({})).rejects.toMatchObject({
      statusCode: 409,
      code: "GOOGLE_CALENDAR_NOT_SELECTED",
    });
  });

  test("returns immediately when internal rules yield no slots", async () => {
    generateInternalSlots.mockResolvedValue([]);
    await expect(provider.getAvailability({ serviceOfferingId: "s1" })).resolves.toEqual([]);
    expect(googleApiRequest).not.toHaveBeenCalled();
  });

  test("queries freeBusy and removes every overlapping interval", async () => {
    generateInternalSlots.mockResolvedValue([
      { startAt: "2026-07-27T17:00:00Z", endAt: "2026-07-27T18:00:00Z" },
      { startAt: "2026-07-27T18:00:00Z", endAt: "2026-07-27T19:00:00Z" },
      { startAt: "2026-07-27T20:00:00Z", endAt: "2026-07-27T21:00:00Z" },
    ]);
    googleApiRequest.mockResolvedValue({
      items: [],
      calendars: {
        "calendar@example.com": {
          busy: [
            { start: "2026-07-27T16:30:00Z", end: "2026-07-27T17:30:00Z" },
            { start: "2026-07-27T18:30:00Z", end: "2026-07-27T20:00:00Z" },
          ],
        },
      },
    });
    await expect(provider.getAvailability({ serviceOfferingId: "s1" })).resolves.toEqual([
      { startAt: "2026-07-27T20:00:00Z", endAt: "2026-07-27T21:00:00Z" },
    ]);
    expect(googleApiRequest).toHaveBeenCalledWith({
      businessId: "b1",
      path: "/freeBusy",
      method: "POST",
      body: expect.objectContaining({
        timeMin: "2026-07-27T17:00:00.000Z",
        timeMax: "2026-07-27T21:00:00.000Z",
        timeZone: "America/New_York",
        items: [{ id: "calendar@example.com" }],
      }),
    });
  });

  test("fails closed when freeBusy returns no calendar evidence", async () => {
    generateInternalSlots.mockResolvedValue([{ startAt: "2026-07-27T17:00:00Z", endAt: "2026-07-27T18:00:00Z" }]);
    googleApiRequest.mockImplementation(async ({path})=>path==="/freeBusy"?{}:{items:[]});
    await expect(provider.getAvailability({})).rejects.toMatchObject({code:"GOOGLE_AVAILABILITY_CALENDAR_ERROR"});
  });

  test("creates a complete Google event", async () => {
    allowCalendarWrites({ id: "event-1", htmlLink: "link" });
    const appointment = {
      _id: "a1",
      lead: "l1",
      conversation: "c1",
      customerName: "Jane",
      customerPhone: "+14045550100",
      customerEmail: "jane@example.com",
      address: { street: "123 Main", city: "Atlanta", state: "GA", postalCode: "30318" },
      startAt: "2026-07-27T17:00:00Z",
      endAt: "2026-07-27T18:30:00Z",
      estimatedValue: 300,
      notes: "Gate code 1",
      timezone: "America/New_York",
    };
    await expect(
      provider.createAppointment({ appointment, service: { name: "Drain cleaning" } }),
    ).resolves.toEqual({
      provider: "google_calendar",
      externalAppointmentId: "event-1",
      externalCalendarId: "calendar@example.com",
      raw: { id: "event-1", htmlLink: "link" },
    });
    expect(googleApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/calendars/calendar%40example.com/events?sendUpdates=all",
        method: "POST",
        body: expect.objectContaining({
          summary: "Drain cleaning — Jane",
          description: expect.stringContaining("MeekCall appointment: a1"),
          start: { dateTime: "2026-07-27T17:00:00.000Z", timeZone: "America/New_York" },
          attendees: [{ email: "jane@example.com" }],
        }),
      }),
    );
  });

  test("uses fallback event labels and business timezone", async () => {
    allowCalendarWrites({id:"event-1"});
    await provider.createAppointment({
      appointment: { _id: "a1", startAt: "2026-07-27T17:00:00Z", endAt: "2026-07-27T18:00:00Z", address: {} },
    });
    expect(googleApiRequest.mock.calls.find(([request])=>request.method==="POST" && request.path!=="/freeBusy")[0].body).toMatchObject({
      summary: "Service appointment — Customer",
      start: { timeZone: "America/New_York" },
    });
  });

  test("updates document and plain-object appointments", async () => {
    allowCalendarWrites({id:"event-2"});
    const documentAppointment = {
      _id: "a1",
      externalAppointmentId: "event old/id",
      externalCalendarId: "custom/calendar",
      toObject: () => ({
        _id: "a1",
        customerName: "Jane",
        startAt: "2026-07-27T17:00:00Z",
        endAt: "2026-07-27T18:00:00Z",
        address: {},
      }),
    };
    await provider.updateAppointment({
      appointment: documentAppointment,
      changes: { startAt: "2026-07-28T17:00:00Z", endAt: "2026-07-28T18:00:00Z" },
      service: { name: "Service" },
    });
    expect(googleApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/calendars/custom%2Fcalendar/events/event%20old%2Fid?sendUpdates=all" }),
    );

    allowCalendarWrites({id:"event-3"});
    await provider.updateAppointment({
      appointment: {
        _id: "a2",
        externalAppointmentId: "event-2",
        startAt: "2026-07-27T17:00:00Z",
        endAt: "2026-07-27T18:00:00Z",
        address: {},
      },
      changes: {},
    });
    expect(googleApiRequest.mock.calls.filter(([request])=>request.method==="PUT")).toHaveLength(2);
  });

  test("rejects updates without an event ID", async () => {
    await expect(
      provider.updateAppointment({
        appointment: { _id: "a1", startAt: new Date(), endAt: new Date(), address: {} },
        changes: {},
      }),
    ).rejects.toThrow("Google event ID is missing");
  });

  test("cancels, treats missing events as already absent, gets events, and tests connection", async () => {
    await expect(provider.cancelAppointment({ appointment: { externalCalendarId: "cal" } })).resolves.toEqual({
      canceled: true,
      alreadyMissing: true,
    });

    googleApiRequest.mockResolvedValueOnce(undefined);
    await expect(
      provider.cancelAppointment({ appointment: { externalAppointmentId: "e1", externalCalendarId: "cal" } }),
    ).resolves.toEqual({ canceled: true });

    googleApiRequest.mockResolvedValueOnce({ id: "e1" });
    await expect(
      provider.getAppointment({ appointment: { externalAppointmentId: "e1", externalCalendarId: "cal" } }),
    ).resolves.toEqual({ id: "e1" });

    googleApiRequest.mockResolvedValueOnce({ id: "cal", summary: "Bookings", timeZone: "UTC" });
    await expect(provider.testConnection()).resolves.toEqual({
      connected: true,
      provider: "google_calendar",
      calendar: { id: "cal", summary: "Bookings", timeZone: "UTC" },
    });
  });
});

afterEach(()=>jest.restoreAllMocks());
