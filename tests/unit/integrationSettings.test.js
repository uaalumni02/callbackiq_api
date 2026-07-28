import { getGoogleSettings, getJobberSettings } from "../../src/services/integrations/integrationSettings.service.js";

describe("integration settings", () => {
  test("Google settings remain backward compatible with providerCalendarId", () => {
    const result = getGoogleSettings({
      providerCalendarId: "primary",
      metadata: {},
    });
    expect(result.bookingCalendarId).toBe("primary");
    expect(result.availabilityCalendarIds).toEqual(["primary"]);
  });

  test("Google settings deduplicate availability calendars", () => {
    const result = getGoogleSettings({
      providerCalendarId: "primary",
      metadata: {
        googleCalendar: {
          bookingCalendarId: "dispatch",
          availabilityCalendarIds: ["dispatch", "tech-1", "tech-1"],
        },
      },
    });
    expect(result.availabilityCalendarIds).toEqual(["dispatch", "tech-1"]);
  });

  test("Jobber defaults to qualified lead request handoff", () => {
    const result = getJobberSettings({ metadata: {} });
    expect(result.syncQualifiedLeads).toBe(true);
    expect(result.createRequestOn).toBe("qualified");
  });
});
