import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";
import GoogleCalendarProvider from "../../src/integrations/scheduling/googleCalendar.provider.js";
import HousecallProProvider from "../../src/integrations/scheduling/housecallPro.provider.js";
import InternalSchedulingProvider from "../../src/integrations/scheduling/internalScheduling.provider.js";
import JobberProvider from "../../src/integrations/scheduling/jobber.provider.js";
import ServiceTitanProvider from "../../src/integrations/scheduling/serviceTitan.provider.js";

describe("SchedulingProviderFactory", () => {
  const base = { _id: "business-1" };

  test.each([
    [undefined, InternalSchedulingProvider],
    ["internal", InternalSchedulingProvider],
    ["google", GoogleCalendarProvider],
    ["google_calendar", GoogleCalendarProvider],
    ["jobber", JobberProvider],
    ["housecall_pro", HousecallProProvider],
    ["servicetitan", ServiceTitanProvider],
  ])("selects %s", (providerName, Expected) => {
    const business = providerName ? { ...base, features: { calendarProvider: providerName } } : base;
    expect(SchedulingProviderFactory.getProvider(business)).toBeInstanceOf(Expected);
  });

  test("supports legacy featureSettings", () => {
    expect(
      SchedulingProviderFactory.getProvider({
        ...base,
        featureSettings: { calendarProvider: "jobber" },
      }),
    ).toBeInstanceOf(JobberProvider);
  });

  test("an explicit override wins", () => {
    expect(
      SchedulingProviderFactory.getProvider(
        { ...base, features: { calendarProvider: "internal" } },
        "google_calendar",
      ),
    ).toBeInstanceOf(GoogleCalendarProvider);
  });

  test("rejects unknown providers", () => {
    expect(() =>
      SchedulingProviderFactory.getProvider({ ...base, features: { calendarProvider: "unknown" } }),
    ).toThrow("Unsupported scheduling provider: unknown");
    try {
      SchedulingProviderFactory.getProvider({ ...base, features: { calendarProvider: "unknown" } });
    } catch (error) {
      expect(error.statusCode).toBe(400);
    }
  });
});
