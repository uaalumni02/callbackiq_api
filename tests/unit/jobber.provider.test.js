import ExternalRecordMapping from "../../src/models/externalRecordMapping.js";
import JobberProvider from "../../src/integrations/scheduling/jobber.provider.js";
import { generateInternalSlots } from "../../src/services/scheduling/slotGenerator.service.js";
import {
  assertNoJobberUserErrors,
  getJobberConnection,
  jobberGraphqlRequest,
} from "../../src/services/integrations/jobberConnection.service.js";

jest.mock("../../src/models/externalRecordMapping.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/services/scheduling/slotGenerator.service.js", () => ({
  __esModule: true,
  generateInternalSlots: jest.fn(),
}));
jest.mock("../../src/services/integrations/jobberConnection.service.js", () => ({
  __esModule: true,
  assertNoJobberUserErrors: jest.fn(),
  getJobberConnection: jest.fn(),
  jobberGraphqlRequest: jest.fn(),
}));

describe("JobberProvider", () => {
  const business = { _id: "b1" };
  let provider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new JobberProvider({ business });
  });

  test("keeps internal availability rules authoritative", async () => {
    generateInternalSlots.mockResolvedValue([{ startAt: "date" }]);
    await expect(provider.getAvailability({ serviceOfferingId: "s1" })).resolves.toHaveLength(1);
    expect(generateInternalSlots).toHaveBeenCalledWith({ serviceOfferingId: "s1", business });
  });

  test("rejects missing reviewed operation templates", async () => {
    getJobberConnection.mockResolvedValue({ metadata: { operations: {} } });
    await expect(provider.runMutation({ operationKey: "createAppointment", variables: {} })).rejects.toMatchObject({
      statusCode: 409,
      code: "JOBBER_OPERATION_NOT_CONFIGURED",
    });
  });

  test("rejects incomplete operation templates", async () => {
    getJobberConnection.mockResolvedValue({
      metadata: { operations: { createAppointment: { query: "mutation" } } },
    });
    await expect(provider.runMutation({ operationKey: "createAppointment", variables: {} })).rejects.toMatchObject({
      code: "JOBBER_OPERATION_NOT_CONFIGURED",
    });
  });

  test("runs configured mutations, resolves nested paths, and validates user errors", async () => {
    const operation = { query: "mutation Test", resultPath: "create.visit" };
    getJobberConnection.mockResolvedValue({ metadata: { operations: { createAppointment: operation } } });
    jobberGraphqlRequest.mockResolvedValue({ create: { visit: { id: "v1" } } });
    await expect(
      provider.runMutation({ operationKey: "createAppointment", variables: { input: {} } }),
    ).resolves.toEqual({ result: { id: "v1" }, operation });
    expect(assertNoJobberUserErrors).toHaveBeenCalledWith({ id: "v1" }, "createAppointment");
  });

  test("creates a mapped Jobber appointment", async () => {
    jest.spyOn(provider, "runMutation").mockResolvedValue({
      result: { payload: { external: { id: "visit-1" } } },
      operation: { externalIdPath: "payload.external.id", externalType: "scheduled_visit" },
    });
    ExternalRecordMapping.findOneAndUpdate.mockResolvedValue({ _id: "map" });
    const appointment = {
      _id: "a1",
      customerName: "Jane",
      customerPhone: "+14045550100",
      customerEmail: "jane@example.com",
      startAt: "2026-07-27T17:00:00Z",
      endAt: "2026-07-27T18:00:00Z",
      address: { postalCode: "30318" },
      notes: "notes",
    };
    await expect(provider.createAppointment({ appointment, service: { name: "Repair" } })).resolves.toEqual({
      provider: "jobber",
      externalAppointmentId: "visit-1",
      externalCalendarId: "jobber",
      raw: { payload: { external: { id: "visit-1" } } },
    });
    expect(ExternalRecordMapping.findOneAndUpdate).toHaveBeenCalledWith(
      {
        business: "b1",
        provider: "jobber",
        localModel: "Appointment",
        localId: "a1",
        externalType: "scheduled_visit",
      },
      { $set: expect.objectContaining({ externalId: "visit-1", syncStatus: "synced", lastSyncedAt: expect.any(Date) }) },
      { upsert: true, new: true },
    );
  });

  test("uses default service and mapping fields", async () => {
    jest.spyOn(provider, "runMutation").mockResolvedValue({ result: { id: 123 }, operation: {} });
    ExternalRecordMapping.findOneAndUpdate.mockResolvedValue({});
    const result = await provider.createAppointment({
      appointment: {
        _id: "a1",
        startAt: "2026-07-27T17:00:00Z",
        endAt: "2026-07-27T18:00:00Z",
      },
    });
    expect(result.externalAppointmentId).toBe("123");
    expect(ExternalRecordMapping.findOneAndUpdate.mock.calls[0][0].externalType).toBe("visit");
  });

  test("rejects a create response without an external ID", async () => {
    jest.spyOn(provider, "runMutation").mockResolvedValue({ result: {}, operation: {} });
    await expect(
      provider.createAppointment({ appointment: { _id: "a1", startAt: new Date(), endAt: new Date() } }),
    ).rejects.toThrow("Jobber returned no external appointment ID.");
  });

  test("updates and cancels appointments", async () => {
    jest.spyOn(provider, "runMutation").mockResolvedValue({ result: { ok: true } });
    await expect(
      provider.updateAppointment({
        appointment: { externalAppointmentId: "v1" },
        changes: { startAt: "2026-07-28T17:00:00Z", endAt: "2026-07-28T18:00:00Z" },
      }),
    ).resolves.toMatchObject({ provider: "jobber", externalAppointmentId: "v1", raw: { ok: true } });
    await expect(provider.cancelAppointment({ appointment: { externalAppointmentId: "v1" } })).resolves.toEqual({
      canceled: true,
      raw: { ok: true },
    });
  });

  test("gets an appointment through its configured result path", async () => {
    getJobberConnection.mockResolvedValue({
      metadata: { operations: { getAppointment: { query: "query", resultPath: "visit.node" } } },
    });
    jobberGraphqlRequest.mockResolvedValue({ visit: { node: { id: "v1" } } });
    await expect(provider.getAppointment({ appointment: { externalAppointmentId: "v1" } })).resolves.toEqual({ id: "v1" });
  });

  test("tests the Jobber account connection using id fallback", async () => {
    const idBusinessProvider = new JobberProvider({ business: { id: "b2" } });
    jobberGraphqlRequest.mockResolvedValue({ account: { id: "account-1", name: "Business" } });
    await expect(idBusinessProvider.testConnection()).resolves.toEqual({
      connected: true,
      provider: "jobber",
      account: { id: "account-1", name: "Business" },
    });
  });
});
