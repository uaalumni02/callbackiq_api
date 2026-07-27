import SchedulingProvider, {
  SchedulingProvider as NamedSchedulingProvider,
} from "../../src/integrations/scheduling/schedulingProvider.js";

describe("SchedulingProvider contract", () => {
  test("requires a business", () => {
    expect(() => new SchedulingProvider({})).toThrow(
      "A business is required to initialize a scheduling provider.",
    );
  });

  test("exports the same class as default and named", () => {
    expect(SchedulingProvider).toBe(NamedSchedulingProvider);
  });

  test.each([
    "getAvailability",
    "createAppointment",
    "updateAppointment",
    "cancelAppointment",
    "getAppointment",
    "testConnection",
  ])("requires providers to implement %s", async (method) => {
    const provider = new SchedulingProvider({ business: { _id: "business-1" } });
    await expect(provider[method]()).rejects.toThrow(
      `${method}() must be implemented by the provider.`,
    );
  });
});
