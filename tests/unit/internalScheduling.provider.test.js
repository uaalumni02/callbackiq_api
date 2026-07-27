import InternalSchedulingProvider from "../../src/integrations/scheduling/internalScheduling.provider.js";
import { generateInternalSlots } from "../../src/services/scheduling/slotGenerator.service.js";

jest.mock("../../src/services/scheduling/slotGenerator.service.js", () => ({
  __esModule: true,
  generateInternalSlots: jest.fn(),
}));

describe("InternalSchedulingProvider", () => {
  const business = { _id: "business-1" };
  let provider;

  beforeEach(() => {
    provider = new InternalSchedulingProvider({ business });
  });

  test("delegates availability to the internal slot generator", async () => {
    generateInternalSlots.mockResolvedValue([{ startAt: new Date(), endAt: new Date() }]);
    const options = { serviceOfferingId: "service-1" };
    const result = await provider.getAvailability(options);
    expect(generateInternalSlots).toHaveBeenCalledWith({ ...options, business });
    expect(result).toHaveLength(1);
  });

  test("creates an internal provider record", async () => {
    await expect(provider.createAppointment({ appointment: { _id: "appointment-1" } })).resolves.toEqual({
      provider: "internal",
      externalAppointmentId: "internal:appointment-1",
      externalCalendarId: "callbackiq",
      raw: null,
    });
  });

  test("updates with existing or generated external IDs", async () => {
    await expect(
      provider.updateAppointment({
        appointment: { _id: "a1", externalAppointmentId: "existing" },
        changes: { notes: "updated" },
      }),
    ).resolves.toMatchObject({ externalAppointmentId: "existing", changes: { notes: "updated" } });

    await expect(
      provider.updateAppointment({ appointment: { _id: "a2" }, changes: {} }),
    ).resolves.toMatchObject({ externalAppointmentId: "internal:a2" });
  });

  test("cancels with existing or generated external IDs", async () => {
    await expect(
      provider.cancelAppointment({ appointment: { _id: "a1", externalAppointmentId: "existing" } }),
    ).resolves.toEqual({ provider: "internal", externalAppointmentId: "existing", canceled: true });
    await expect(provider.cancelAppointment({ appointment: { _id: "a2" } })).resolves.toEqual({
      provider: "internal",
      externalAppointmentId: "internal:a2",
      canceled: true,
    });
  });

  test("returns appointments and reports a healthy connection", async () => {
    const appointment = { _id: "a1" };
    await expect(provider.getAppointment({ appointment })).resolves.toBe(appointment);
    await expect(provider.testConnection()).resolves.toEqual({ connected: true, provider: "internal" });
  });
});
