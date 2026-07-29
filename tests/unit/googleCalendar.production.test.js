import {
  GOOGLE_SCOPES,
  signGoogleOAuthState,
  verifyGoogleOAuthState,
} from "../../src/services/integrations/googleCalendarConnection.service.js";
import GoogleCalendarProvider, {
  buildGoogleEvent,
  deterministicEventId,
} from "../../src/integrations/scheduling/googleCalendar.provider.js";
import { generateInternalSlots } from "../../src/services/scheduling/slotGenerator.service.js";
import {
  getGoogleConnection,
  googleApiRequest,
} from "../../src/services/integrations/googleCalendarConnection.service.js";
import { getGoogleSettings } from "../../src/services/integrations/integrationSettings.service.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/models/integrationConnection.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock("../../src/services/integrations/tokenEncryption.service.js", () => ({
  __esModule: true,
  encryptSecret: jest.fn((value) => `encrypted:${value}`),
  decryptSecret: jest.fn((value) => String(value).replace(/^encrypted:/, "")),
}));

jest.mock("../../src/services/scheduling/slotGenerator.service.js", () => ({
  __esModule: true,
  generateInternalSlots: jest.fn(),
}));

jest.mock(
  "../../src/services/integrations/googleCalendarConnection.service.js",
  () => {
    const actual = jest.requireActual(
      "../../src/services/integrations/googleCalendarConnection.service.js",
    );
    return {
      __esModule: true,
      ...actual,
      getGoogleConnection: jest.fn(),
      googleApiRequest: jest.fn(),
      listGoogleCalendars: jest.fn(),
    };
  },
);

jest.mock(
  "../../src/services/integrations/integrationSettings.service.js",
  () => ({
    __esModule: true,
    getGoogleSettings: jest.fn(),
  }),
);

describe("production Google Calendar integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("uses narrow identity, calendar-list, free-busy, and event scopes", () => {
    expect(GOOGLE_SCOPES).toEqual(
      expect.arrayContaining([
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.freebusy",
        "https://www.googleapis.com/auth/calendar.events",
      ]),
    );
    expect(GOOGLE_SCOPES).not.toContain(
      "https://www.googleapis.com/auth/calendar",
    );
  });

  test("signs, verifies, expires, and rejects modified OAuth state", () => {
    const secret = "a-production-length-state-secret";
    const state = signGoogleOAuthState(
      {
        businessId: "business-1",
        ownerId: "owner-1",
        nonce: "nonce-1",
        exp: 10_000,
      },
      secret,
    );

    expect(verifyGoogleOAuthState(state, secret, 9_999)).toMatchObject({
      businessId: "business-1",
      ownerId: "owner-1",
      nonce: "nonce-1",
    });
    expect(() => verifyGoogleOAuthState(state, secret, 10_001)).toThrow(
      /expired/i,
    );
    expect(() =>
      verifyGoogleOAuthState(`${state}modified`, secret, 9_999),
    ).toThrow(/signature|invalid/i);
  });

  test("removes conflicts from every selected availability calendar", async () => {
    const slots = [
      {
        startAt: "2026-08-03T13:00:00.000Z",
        endAt: "2026-08-03T14:00:00.000Z",
      },
      {
        startAt: "2026-08-03T15:00:00.000Z",
        endAt: "2026-08-03T16:00:00.000Z",
      },
      {
        startAt: "2026-08-03T17:00:00.000Z",
        endAt: "2026-08-03T18:00:00.000Z",
      },
    ];
    generateInternalSlots.mockResolvedValue(slots);
    getGoogleConnection.mockResolvedValue({
      status: "connected",
      providerCalendarId: "booking",
      availabilityCalendarIds: ["booking", "owner"],
    });
    getGoogleSettings.mockReturnValue({
      bookingCalendarId: "booking",
      availabilityCalendarIds: ["booking", "owner"],
      sendUpdates: "none",
    });
    googleApiRequest.mockResolvedValue({
      calendars: {
        booking: {
          busy: [
            {
              start: "2026-08-03T13:30:00.000Z",
              end: "2026-08-03T14:30:00.000Z",
            },
          ],
        },
        owner: {
          busy: [
            {
              start: "2026-08-03T15:30:00.000Z",
              end: "2026-08-03T16:30:00.000Z",
            },
          ],
        },
      },
    });

    const provider = new GoogleCalendarProvider({
      business: {
        _id: "business-1",
        timezone: "America/New_York",
      },
    });
    const result = await provider.getAvailability({
      startDate: "2026-08-03",
      endDate: "2026-08-03",
    });

    expect(result).toEqual([slots[2]]);
    expect(googleApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        path: "/freeBusy",
        method: "POST",
        body: expect.objectContaining({
          items: [{ id: "booking" }, { id: "owner" }],
        }),
      }),
    );
  });

  test("creates deterministic private events with tenant metadata", () => {
    const appointment = {
      _id: "507f1f77bcf86cd799439011",
      business: "507f191e810c19729de860ea",
      customerName: "Jane Smith",
      customerPhone: "+14045550127",
      startAt: "2026-08-03T13:00:00.000Z",
      endAt: "2026-08-03T14:00:00.000Z",
      timezone: "America/New_York",
      address: {
        street: "100 Main Street",
        city: "Atlanta",
        state: "GA",
        postalCode: "30303",
      },
    };
    const event = buildGoogleEvent({
      appointment,
      service: { name: "Water heater repair" },
      business: { _id: appointment.business, timezone: appointment.timezone },
    });

    expect(deterministicEventId(appointment)).toMatch(/^[0-9a-f]{32}$/);
    expect(event.id).toBe(deterministicEventId(appointment));
    expect(event.visibility).toBe("private");
    expect(event.transparency).toBe("opaque");
    expect(event.extendedProperties.private).toMatchObject({
      callbackiqAppointmentId: appointment._id,
      callbackiqBusinessId: appointment.business,
    });
  });
});
