import HousecallProProvider from "../../src/integrations/scheduling/housecallPro.provider.js";
import ServiceTitanProvider from "../../src/integrations/scheduling/serviceTitan.provider.js";

describe.each([
  ["Housecall Pro", HousecallProProvider],
  ["ServiceTitan", ServiceTitanProvider],
])("%s provider placeholder", (name, Provider) => {
  test.each([
    "getAvailability",
    "createAppointment",
    "updateAppointment",
    "cancelAppointment",
    "getAppointment",
    "testConnection",
  ])("rejects %s until configured", async (method) => {
    const provider = new Provider({ business: { _id: "business-1" } });
    await expect(provider[method]()).rejects.toMatchObject({
      statusCode: 409,
      code: "PROVIDER_NOT_CONFIGURED",
    });
  });

  test("exposes the provider-specific message", () => {
    const provider = new Provider({ business: { _id: "business-1" } });
    expect(() => provider.notConfigured()).toThrow(`${name} scheduling is not configured yet.`);
  });
});
