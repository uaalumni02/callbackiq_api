jest.mock("../../src/services/integrations/googleCalendarConnection.service.js", () => ({
  getGoogleConnection: jest.fn(),
  googleApiRequest: jest.fn(),
  listGoogleCalendars: jest.fn(),
}));
jest.mock("../../src/services/integrations/integrationSettings.service.js", () => ({ getGoogleSettings: jest.fn() }));

import { getGoogleConnection, googleApiRequest } from "../../src/services/integrations/googleCalendarConnection.service.js";
import { getGoogleSettings } from "../../src/services/integrations/integrationSettings.service.js";
import GoogleCalendarProvider, { buildGoogleEvent, deterministicEventId } from "../../src/integrations/scheduling/googleCalendar.provider.js";

describe("Google Calendar provider", () => {
  test("event IDs are deterministic and Google-compatible", () => {
    const appointment = {
      _id: "507f1f77bcf86cd799439011",
      business: "507f191e810c19729de860ea",
    };
    const first = deterministicEventId(appointment);
    const second = deterministicEventId(appointment);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });
});


describe("Google Calendar confirmation recovery", () => {
  const business = { _id: "507f191e810c19729de860ea" };
  const appointment = {
    _id: "507f1f77bcf86cd799439011", business: business._id, customerName: "Customer",
    startAt: new Date("2027-04-01T17:00:00Z"), endAt: new Date("2027-04-01T18:00:00Z"),
  };
  const event = buildGoogleEvent({ appointment, business });
  const target = { accountId: "account", calendarId: "original@example.com", eventId: event.id };
  const provider = new GoogleCalendarProvider({ business });
  beforeEach(() => {
    jest.resetAllMocks();
    getGoogleConnection.mockResolvedValue({ status: "connected", providerAccountId: "account" });
    getGoogleSettings.mockReturnValue({ bookingCalendarId: "new@example.com" });
  });

  test("recovers a matching event from the stored calendar after settings change", async () => {
    googleApiRequest.mockResolvedValueOnce(event);
    await expect(provider.findConfirmation({ appointment, target })).resolves.toMatchObject({
      externalAppointmentId: event.id, externalCalendarId: target.calendarId,
    });
    expect(googleApiRequest).toHaveBeenCalledWith(expect.objectContaining({
      path: `/calendars/original%40example.com/events/${event.id}`,
    }));
    await expect(provider.assertConfirmationRetryTarget({ appointment, target }))
      .rejects.toMatchObject({ code: "GOOGLE_CONFIRMATION_CALENDAR_CHANGED" });
  });

  test("checks the original calendar still exists before interpreting a 404 as absence", async () => {
    googleApiRequest.mockResolvedValueOnce({ __providerStatus: 404 }).mockResolvedValueOnce({ id: target.calendarId });
    await expect(provider.findConfirmation({ appointment, target })).resolves.toBeNull();
    expect(googleApiRequest).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/calendars/original%40example.com" }));
  });

  test("does not mistake a calendar permission loss for a missing event", async () => {
    const forbidden = Object.assign(new Error("Calendar cannot be read"), { providerStatus: 404 });
    googleApiRequest.mockResolvedValueOnce({ __providerStatus: 404 }).mockRejectedValueOnce(forbidden);
    await expect(provider.findConfirmation({ appointment, target })).rejects.toBe(forbidden);
  });

  test("requires a matching account and appointment before accepting an event", async () => {
    await expect(provider.findConfirmation({ appointment, target: { ...target, accountId: "other" } }))
      .rejects.toMatchObject({ code: "GOOGLE_CONFIRMATION_ACCOUNT_CHANGED" });
    expect(googleApiRequest).not.toHaveBeenCalled();
    googleApiRequest.mockResolvedValueOnce({ ...event, extendedProperties: { private: { callbackiqBusinessId: "other" } } });
    await expect(provider.findConfirmation({ appointment, target }))
      .rejects.toMatchObject({ code: "GOOGLE_CONFIRMATION_EVENT_MISMATCH" });
    googleApiRequest.mockResolvedValueOnce({ ...event, status: "cancelled" });
    await expect(provider.findConfirmation({ appointment, target }))
      .rejects.toMatchObject({ code: "GOOGLE_CONFIRMATION_EVENT_CANCELED", confirmationRejected: true });
  });

  test("uses the concrete primary calendar ID before persisting the target", async () => {
    getGoogleSettings.mockReturnValue({ bookingCalendarId: "primary" });
    googleApiRequest.mockResolvedValueOnce({ id: target.calendarId });
    await expect(provider.prepareConfirmation({ appointment })).resolves.toEqual(target);
  });

  test("a duplicate event ID must return matching Google event evidence", async () => {
    googleApiRequest.mockRejectedValueOnce(Object.assign(new Error("already exists"), { providerStatus: 409 }))
      .mockResolvedValueOnce(event);
    await expect(provider.createAppointment({ appointment, target })).resolves.toMatchObject({
      externalAppointmentId: event.id, externalCalendarId: target.calendarId,
    });
    expect(googleApiRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: "POST", body: expect.objectContaining({ id: target.eventId }),
    }));
    googleApiRequest.mockResolvedValueOnce({ id: event.id });
    await expect(provider.createAppointment({ appointment, target }))
      .rejects.toMatchObject({ code: "GOOGLE_CONFIRMATION_EVENT_MISMATCH" });
  });

  test("refuses to guess an unresolved primary calendar and allows a pinned calendar match", async () => {
    getGoogleSettings.mockReturnValue({ bookingCalendarId: "primary" });
    googleApiRequest.mockResolvedValueOnce({}).mockResolvedValueOnce({ id: target.calendarId });
    await expect(provider.prepareConfirmation({ appointment }))
      .rejects.toThrow("Google did not return the writable calendar ID");
    await expect(provider.assertConfirmationRetryTarget({ appointment, target })).resolves.toBeUndefined();
  });

  test("ordinary create without a recovery target keeps the configured calendar", async () => {
    const legacyProvider = new GoogleCalendarProvider({ business: { id: business._id } });
    googleApiRequest.mockResolvedValueOnce({ id: event.id });

    await expect(legacyProvider.createAppointment({ appointment })).resolves.toMatchObject({
      externalAppointmentId: event.id, externalCalendarId: "new@example.com",
    });
    expect(googleApiRequest).toHaveBeenCalledWith(expect.objectContaining({
      businessId: business._id, path: expect.stringContaining("/calendars/new%40example.com/events?"),
    }));
    expect(googleApiRequest.mock.calls[0][0]).not.toHaveProperty("signal");
  });

  test("marks only definite rejections from a pinned creation as known failures", async () => {
    const rejected = Object.assign(new Error("Calendar permission denied"), { providerStatus: 403 });
    const timedOut = new Error("Connection timed out");
    const legacyRejected = Object.assign(new Error("Calendar permission denied"), { providerStatus: 403 });
    googleApiRequest.mockRejectedValueOnce(rejected).mockRejectedValueOnce(timedOut).mockRejectedValueOnce(legacyRejected);

    await expect(provider.createAppointment({ appointment, target })).rejects.toBe(rejected);
    expect(rejected.confirmationCreateRejected).toBe(true);
    await expect(provider.createAppointment({ appointment, target })).rejects.toBe(timedOut);
    expect(timedOut).not.toHaveProperty("confirmationCreateRejected");
    await expect(provider.createAppointment({ appointment })).rejects.toBe(legacyRejected);
    expect(legacyRejected).not.toHaveProperty("confirmationCreateRejected");
  });

  test("compensation verifies a missing event against the pinned calendar and leaves ordinary cancellation unchanged", async () => {
    const canceledAppointment = { ...appointment, externalAppointmentId: event.id, externalCalendarId: target.calendarId };
    googleApiRequest
      .mockResolvedValueOnce({ __providerStatus: 410 }).mockResolvedValueOnce({ id: target.calendarId })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ __providerStatus: 404 });

    await expect(provider.cancelAppointment({ appointment: canceledAppointment, target }))
      .resolves.toEqual({ canceled: true, alreadyMissing: true });
    expect(googleApiRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: "DELETE", path: expect.stringContaining("/calendars/original%40example.com/events/"),
    }));
    expect(googleApiRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: "/calendars/original%40example.com" }));
    await expect(provider.cancelAppointment({ appointment: canceledAppointment, target })).resolves.toEqual({ canceled: true });
    await expect(provider.cancelAppointment({ appointment: canceledAppointment }))
      .resolves.toEqual({ canceled: true, alreadyMissing: true });
    expect(googleApiRequest).toHaveBeenCalledTimes(4);
    expect(googleApiRequest.mock.calls[3][0]).not.toHaveProperty("signal");
  });

});
