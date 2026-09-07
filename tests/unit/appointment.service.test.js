import Appointment from "../../src/models/appointment.js";
import Lead from "../../src/models/lead.js";
import ServiceOffering from "../../src/models/serviceOffering.js";
import AlertService from "../../src/services/alert.service.js";
import AutomationTriggerService from "../../src/services/automation/automationTrigger.service.js";
import ConversionEventService from "../../src/services/conversionEvent.service.js";
import InterventionService from "../../src/services/intervention.service.js";
import SocketService from "../../src/services/socket.service.js";
import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import {
  getBookableService,
  getSlotCapacity,
} from "../../src/services/scheduling/appointmentPolicy.service.js";
import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";
import { addMinutes, formatDateKey } from "../../src/services/scheduling/timezone.service.js";
import AppointmentService, {
  ACTIVE_STATUSES,
  VALID_TRANSITIONS,
} from "../../src/services/scheduling/appointment.service.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), create: jest.fn(), updateMany: jest.fn(), find: jest.fn() },
}));
jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { findById: jest.fn(), findOne: jest.fn(() => ({ lean: async () => null })), updateOne: jest.fn() },
}));
jest.mock("../../src/models/serviceOffering.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createBookedJobAlert: jest.fn() },
}));
jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: { schedule: jest.fn() },
}));
jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: { markAppointmentBooked: jest.fn(), record: jest.fn() },
}));
jest.mock("../../src/services/intervention.service.js", () => ({
  __esModule: true,
  default: { integrationFailure: jest.fn(), create: jest.fn() },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitToBusiness: jest.fn(), emitDashboardRefresh: jest.fn() },
}));
jest.mock("../../src/services/scheduling/availability.service.js", () => ({
  __esModule: true,
  default: { getAvailability: jest.fn() },
}));
jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getBookableService: jest.fn(),
  getSchedulingPolicy: jest.fn(),
  getSlotCapacity: jest.fn(),
}));
jest.mock("../../src/services/scheduling/schedulingProviderFactory.js", () => ({
  __esModule: true,
  default: { getProvider: jest.fn() },
}));
jest.mock("../../src/services/scheduling/timezone.service.js", () => ({
  __esModule: true,
  addMinutes: jest.fn((date, minutes) => new Date(new Date(date).getTime() + Number(minutes) * 60_000)),
  formatDateKey: jest.fn(() => "2026-07-27"),
}));

const business = {
  _id: "b1",
  timezone: "America/New_York",
  estimatedJobValue: 250,
  features: { calendarProvider: "internal" },
};
const service = {
  _id: "s1",
  name: "Drain cleaning",
  durationMinutes: 90,
  bufferBeforeMinutes: 10,
  bufferAfterMinutes: 15,
  estimatedValue: 300,
};
const matchingSlots = [
  { startAt: "2026-07-27T17:00:00.000Z", endAt: "2026-07-27T18:30:00.000Z" },
];

const appointmentDoc = (overrides = {}) => ({
  _id: "a1",
  business: "b1",
  lead: "l1",
  conversation: "c1",
  serviceOffering: "s1",
  customerName: "Jane",
  customerPhone: "+14045550100",
  customerEmail: "jane@example.com",
  address: { postalCode: "30318" },
  startAt: new Date("2026-07-27T17:00:00.000Z"),
  endAt: new Date("2026-07-27T18:30:00.000Z"),
  timezone: "America/New_York",
  status: "held",
  source: "sms",
  bookedBy: "ai",
  provider: "internal",
  estimatedValue: 300,
  actualRevenue: 0,
  activeSlotKey: "slot",
  slotClaimKeys: ["claim"],
  capacityLane: 1,
  heldExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  notes: "Existing note",
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const populateChain = () => {
  const query = {
    sort: jest.fn(() => query),
    skip: jest.fn(() => query),
    limit: jest.fn(() => query),
    populate: jest.fn(() => query),
  };
  return query;
};

describe("AppointmentService", () => {
  let provider;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    provider = {
      createAppointment: jest.fn().mockResolvedValue({
        provider: "internal",
        externalAppointmentId: "internal:a1",
        externalCalendarId: "callbackiq",
      }),
      cancelAppointment: jest.fn().mockResolvedValue({ canceled: true }),
      updateAppointment: jest.fn().mockResolvedValue({
        provider: "internal",
        externalAppointmentId: "internal:a2",
        externalCalendarId: "callbackiq",
      }),
    };
    SchedulingProviderFactory.getProvider.mockReturnValue(provider);
    getBookableService.mockResolvedValue(service);
    getSlotCapacity.mockResolvedValue(1);
    AvailabilityService.getAvailability.mockResolvedValue({ slots: matchingSlots });
    ServiceOffering.findById.mockResolvedValue(service);
    Lead.findById.mockResolvedValue({ _id: "l1", serviceNeeded: "Repair" });
    Appointment.create.mockImplementation(async (value) => appointmentDoc({ ...value, _id: "a1" }));
    ConversionEventService.markAppointmentBooked.mockResolvedValue({});
    ConversionEventService.record.mockResolvedValue({});
    AlertService.createBookedJobAlert.mockResolvedValue({});
    InterventionService.integrationFailure.mockResolvedValue({});
    InterventionService.create.mockResolvedValue({});
    AutomationTriggerService.schedule.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test("exports expected active statuses and transitions", () => {
    expect([...ACTIVE_STATUSES]).toEqual(["held", "confirmed"]);
    expect(VALID_TRANSITIONS.held.has("confirmed")).toBe(true);
    expect(VALID_TRANSITIONS.confirmed.has("rescheduled")).toBe(true);
    expect(VALID_TRANSITIONS.canceled.size).toBe(0);
  });

  test("releases expired holds globally and per business", async () => {
    Appointment.updateMany.mockResolvedValue({ modifiedCount: 2 });
    await expect(AppointmentService.releaseExpiredHolds()).resolves.toEqual({ modifiedCount: 2 });
    expect(Appointment.updateMany).toHaveBeenCalledWith(
      { status: "held", heldExpiresAt: { $lte: expect.any(Date) } },
      { $set: expect.objectContaining({ status: "failed", slotClaimKeys: [], capacityLane: null }) },
    );
    await AppointmentService.releaseExpiredHolds("b1");
    expect(Appointment.updateMany.mock.calls[1][0]).toMatchObject({ business: "b1" });
  });

  test("requires a customer phone", async () => {
    await expect(
      AppointmentService.create({ business, input: {}, idempotencyKey: "key" }),
    ).rejects.toMatchObject({ statusCode: 400, message: "customerPhone is required." });
  });

  test("returns an existing idempotent appointment", async () => {
    const existing = appointmentDoc({ status: "confirmed" });
    Appointment.findOne.mockResolvedValueOnce(existing);
    await expect(
      AppointmentService.create({ business, input: { customerPhone: "+1" }, idempotencyKey: " key " }),
    ).resolves.toBe(existing);
    expect(Appointment.findOne).toHaveBeenCalledWith({ business: "b1", idempotencyKey: "key" });
    expect(getBookableService).not.toHaveBeenCalled();
  });

  test("creates a held appointment with normalized defaults and generated end time", async () => {
    Appointment.findOne.mockResolvedValueOnce(null);
    const result = await AppointmentService.create({
      business: { ...business, features: { calendarProvider: "google" } },
      input: {
        customerPhone: "+14045550100",
        customerName: "",
        customerEmail: "",
        serviceOfferingId: "s1",
        startAt: "2026-07-27T17:00:00.000Z",
        address: { street: " 123 Main ", city: " Atlanta ", state: " GA ", postalCode: " 30318 " },
        holdMinutes: 7,
      },
      idempotencyKey: "create-1",
      confirm: false,
    });
    expect(result.status).toBe("held");
    expect(Appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: "Customer",
        address: { street: "123 Main", city: "Atlanta", state: "GA", postalCode: "30318" },
        endAt: new Date("2026-07-27T18:30:00.000Z"),
        provider: "google_calendar",
        estimatedValue: null,
        actualRevenue: 0,
        capacityLane: 1,
        activeSlotKey: "2026-07-27T17:00:00.000Z|2026-07-27T18:30:00.000Z|lane:1",
        heldExpiresAt: new Date("2026-07-27T12:07:00.000Z"),
      }),
    );
    const claims = Appointment.create.mock.calls[0][0].slotClaimKeys;
    expect(claims[0]).toBe("2026-07-27T16:50:00.000Z|lane:1");
    expect(claims.at(-1)).toBe("2026-07-27T18:44:00.000Z|lane:1");
  });

  test("ignores untrusted input amounts and business averages", async () => {
    Appointment.findOne.mockResolvedValue(null);
    getBookableService.mockResolvedValue({ _id: "s1", durationMinutes: 0, estimatedValue: 0 });
    AvailabilityService.getAvailability.mockResolvedValue({
      slots: [{ startAt: "2026-07-27T17:00:00Z", endAt: "2026-07-27T18:30:00Z" }],
    });
    await AppointmentService.create({
      business: { _id: "b1", estimatedJobValue: 175, features: {} },
      input: {
        customerPhone: "+1",
        serviceOffering: "s1",
        startAt: "2026-07-27T17:00:00Z",
        endAt: "2026-07-27T18:30:00Z",
        timezone: "UTC",
        source: "web",
        bookedBy: "customer",
        estimatedValue: 500,
        actualRevenue: 25,
        notes: "note",
      },
      confirm: false,
    });
    expect(Appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "UTC",
        source: "web",
        bookedBy: "customer",
        provider: "internal",
        estimatedValue: null,
        actualRevenue: 25,
        notes: "note",
      }),
    );
  });

  test("rejects a slot that is no longer available", async () => {
    Appointment.findOne.mockResolvedValueOnce(null);
    AvailabilityService.getAvailability.mockResolvedValue({ slots: [] });
    await expect(
      AppointmentService.create({
        business,
        input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
        confirm: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLOT_UNAVAILABLE" });
  });

  test("uses the next capacity lane after a slot collision", async () => {
    Appointment.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    getSlotCapacity.mockResolvedValue(2);
    Appointment.create
      .mockRejectedValueOnce({ code: 11000 })
      .mockImplementationOnce(async (value) => appointmentDoc({ ...value, _id: "a2" }));
    const result = await AppointmentService.create({
      business,
      input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
      idempotencyKey: "key",
      confirm: false,
    });
    expect(result.capacityLane).toBe(2);
  });

  test("returns the existing appointment after a duplicate idempotency collision", async () => {
    const existing = appointmentDoc({ _id: "existing" });
    Appointment.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    Appointment.create.mockRejectedValueOnce({ code: 11000 });
    await expect(
      AppointmentService.create({
        business,
        input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
        idempotencyKey: "key",
        confirm: false,
      }),
    ).resolves.toBe(existing);
  });

  test("throws nonduplicate create errors and a capacity conflict", async () => {
    Appointment.findOne.mockResolvedValueOnce(null);
    Appointment.create.mockRejectedValueOnce(new Error("validation"));
    await expect(
      AppointmentService.create({
        business,
        input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
        confirm: false,
      }),
    ).rejects.toThrow("validation");

    Appointment.findOne.mockReset().mockResolvedValue(null);
    Appointment.create.mockReset().mockRejectedValue({ code: 11000 });
    getSlotCapacity.mockResolvedValue(1);
    await expect(
      AppointmentService.create({
        business,
        input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
        confirm: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLOT_ALREADY_CLAIMED" });
  });

  test("confirms a newly created hold and skips confirmation when requested or already non-held", async () => {
    Appointment.findOne.mockResolvedValueOnce(null);
    const hold = appointmentDoc({ status: "held" });
    Appointment.create.mockResolvedValueOnce(hold);
    const confirmSpy = jest.spyOn(AppointmentService, "confirm").mockResolvedValue({ status: "confirmed" });
    await expect(
      AppointmentService.create({
        business,
        input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
        idempotencyKey: "key",
      }),
    ).resolves.toEqual({ status: "confirmed" });
    expect(confirmSpy).toHaveBeenCalledWith({ business, appointmentId: "a1" });

    confirmSpy.mockClear();
    Appointment.findOne.mockResolvedValueOnce(null);
    Appointment.create.mockResolvedValueOnce(appointmentDoc({ status: "failed" }));
    await AppointmentService.create({
      business,
      input: { customerPhone: "+1", serviceOfferingId: "s1", startAt: "2026-07-27T17:00:00Z" },
      confirm: true,
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test("returns 404 for an unknown appointment", async () => {
    Appointment.findOne.mockResolvedValue(null);
    await expect(AppointmentService.confirm({ business, appointmentId: "missing" })).rejects.toMatchObject({
      statusCode: 404,
      message: "Appointment not found.",
    });
  });

  test("returns an already confirmed appointment", async () => {
    const confirmed = appointmentDoc({ status: "confirmed" });
    Appointment.findOne.mockResolvedValue(confirmed);
    await expect(AppointmentService.confirm({ business, appointmentId: "a1" })).resolves.toBe(confirmed);
    expect(provider.createAppointment).not.toHaveBeenCalled();
  });

  test("rejects invalid state transitions", async () => {
    Appointment.findOne.mockResolvedValue(appointmentDoc({ status: "canceled" }));
    await expect(AppointmentService.confirm({ business, appointmentId: "a1" })).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_APPOINTMENT_TRANSITION",
    });
  });

  test("fails an expired hold", async () => {
    const appointment = appointmentDoc({ heldExpiresAt: new Date("2026-07-27T11:59:00Z") });
    Appointment.findOne.mockResolvedValue(appointment);
    await expect(AppointmentService.confirm({ business, appointmentId: "a1" })).rejects.toMatchObject({
      statusCode: 409,
      code: "HOLD_EXPIRED",
    });
    expect(appointment).toMatchObject({ status: "failed", activeSlotKey: null, slotClaimKeys: [], capacityLane: null });
  });

  test("fails a hold when the final availability check changes", async () => {
    const appointment = appointmentDoc();
    Appointment.findOne.mockResolvedValue(appointment);
    AvailabilityService.getAvailability.mockResolvedValue({ slots: [] });
    await expect(AppointmentService.confirm({ business, appointmentId: "a1" })).rejects.toMatchObject({
      code: "SLOT_UNAVAILABLE",
    });
    expect(appointment.failureReason).toContain("final availability");
  });

  test("confirms with the provider, records recovery, alerts, and emits", async () => {
    const appointment = appointmentDoc();
    Appointment.findOne.mockResolvedValue(appointment);
    await expect(AppointmentService.confirm({ business, appointmentId: "a1" })).resolves.toBe(appointment);
    expect(provider.createAppointment).toHaveBeenCalledWith({ appointment, service });
    expect(appointment).toMatchObject({
      provider: "internal",
      externalAppointmentId: "internal:a1",
      externalCalendarId: "callbackiq",
      status: "confirmed",
      heldExpiresAt: null,
      failureReason: "",
    });
    expect(ConversionEventService.markAppointmentBooked).toHaveBeenCalledWith({
      appointment,
      lead: { _id: "l1", serviceNeeded: "Repair" },
      channel: "sms",
      bookedBy: "ai",
    });
    expect(AlertService.createBookedJobAlert).toHaveBeenCalledWith(expect.objectContaining({ serviceNeeded: "Drain cleaning" }));
    expect(SocketService.emitToBusiness).toHaveBeenCalledWith("b1", "appointment:confirmed", appointment);
    expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith("b1", "appointment_confirmed");
  });

  test("confirms without a lead and uses provider-result fallbacks", async () => {
    const appointment = appointmentDoc({ lead: null, provider: "jobber" });
    Appointment.findOne.mockResolvedValue(appointment);
    provider.createAppointment.mockResolvedValue({});
    ServiceOffering.findById.mockResolvedValue(null);
    await AppointmentService.confirm({ business, appointmentId: "a1" });
    expect(appointment).toMatchObject({ provider: "jobber", externalAppointmentId: null, externalCalendarId: null });
    expect(Lead.findById).not.toHaveBeenCalled();
    expect(AlertService.createBookedJobAlert).not.toHaveBeenCalled();
  });

  test("fails safely when the provider cannot confirm", async () => {
    const appointment = appointmentDoc();
    Appointment.findOne.mockResolvedValue(appointment);
    const error = new Error("provider timeout");
    provider.createAppointment.mockRejectedValue(error);
    await expect(AppointmentService.confirm({ business, appointmentId: "a1" })).rejects.toBe(error);
    expect(error.safeCustomerMessage).toContain("trouble confirming");
    expect(appointment).toMatchObject({ status: "failed", activeSlotKey: null, heldExpiresAt: null, failureReason: "provider timeout" });
    expect(InterventionService.integrationFailure).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: "a1", error }));
  });

  test("returns an already canceled appointment and rejects invalid cancellation", async () => {
    const canceled = appointmentDoc({ status: "canceled" });
    Appointment.findOne.mockResolvedValueOnce(canceled);
    await expect(AppointmentService.cancel({ business, appointmentId: "a1" })).resolves.toBe(canceled);

    Appointment.findOne.mockResolvedValueOnce(appointmentDoc({ status: "completed" }));
    await expect(AppointmentService.cancel({ business, appointmentId: "a1" })).rejects.toMatchObject({
      code: "INVALID_APPOINTMENT_TRANSITION",
    });
  });

  test("reports provider cancellation failures", async () => {
    const appointment = appointmentDoc({ status: "confirmed" });
    Appointment.findOne.mockResolvedValue(appointment);
    const error = new Error("cancel failed");
    provider.cancelAppointment.mockRejectedValue(error);
    await expect(AppointmentService.cancel({ business, appointmentId: "a1" })).rejects.toBe(error);
    expect(InterventionService.integrationFailure).toHaveBeenCalledWith(expect.objectContaining({ error }));
  });

  test("cancels, records, alerts, schedules recovery, and emits", async () => {
    const appointment = appointmentDoc({ status: "confirmed", notes: "Existing" });
    Appointment.findOne.mockResolvedValue(appointment);
    await expect(
      AppointmentService.cancel({ business, appointmentId: "a1", reason: "Customer unavailable" }),
    ).resolves.toBe(appointment);
    expect(SchedulingProviderFactory.getProvider).toHaveBeenCalledWith(business, "internal");
    expect(appointment).toMatchObject({
      status: "canceled",
      activeSlotKey: null,
      slotClaimKeys: [],
      capacityLane: null,
      notes: "Existing\nCancellation: Customer unavailable",
    });
    expect(ConversionEventService.record).toHaveBeenCalledWith(expect.objectContaining({ type: "appointment_canceled" }));
    expect(InterventionService.create).toHaveBeenCalledWith(expect.objectContaining({ type: "appointment_canceled" }));
    expect(AutomationTriggerService.schedule).toHaveBeenCalledWith(expect.objectContaining({ trigger: "canceled_appointment_recovery" }));
    expect(SocketService.emitToBusiness).toHaveBeenCalledWith("b1", "appointment:canceled", appointment);
  });

  test("cancels without adding an empty reason or scheduling without a conversation", async () => {
    const appointment = appointmentDoc({ status: "confirmed", conversation: null, notes: "" });
    Appointment.findOne.mockResolvedValue(appointment);
    await AppointmentService.cancel({ business, appointmentId: "a1" });
    expect(appointment.notes).toBe("");
    expect(AutomationTriggerService.schedule).not.toHaveBeenCalled();
  });

  test("rejects unavailable replacement slots", async () => {
    const original = appointmentDoc({ status: "confirmed" });
    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(null);
    AvailabilityService.getAvailability.mockResolvedValue({ slots: [] });
    await expect(
      AppointmentService.reschedule({
        business,
        appointmentId: "a1",
        input: { startAt: "2026-07-28T17:00:00Z", endAt: "2026-07-28T18:30:00Z" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SLOT_UNAVAILABLE" });
  });

  test("reschedules and preserves customer context", async () => {
    const original = appointmentDoc({ status: "confirmed", provider: "internal" });
    const replacement = appointmentDoc({
      _id: "a2",
      status: "held",
      startAt: new Date("2026-07-28T17:00:00Z"),
      endAt: new Date("2026-07-28T18:30:00Z"),
      externalAppointmentId: null,
      externalCalendarId: null,
    });
    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(null);
    AvailabilityService.getAvailability.mockResolvedValue({
      slots: [{ startAt: "2026-07-28T17:00:00Z", endAt: "2026-07-28T18:30:00Z" }],
    });
    Appointment.create.mockResolvedValue(replacement);
    await expect(
      AppointmentService.reschedule({
        business,
        appointmentId: "a1",
        input: { startAt: "2026-07-28T17:00:00Z", endAt: "2026-07-28T18:30:00Z" },
        idempotencyKey: "reschedule-key",
      }),
    ).resolves.toBe(replacement);
    expect(replacement.rescheduledFrom).toBe("a1");
    expect(original).toMatchObject({ status: "rescheduled", rescheduledTo: "a2", activeSlotKey: null });
    expect(replacement).toMatchObject({
      status: "confirmed",
      provider: "internal",
      externalAppointmentId: "internal:a2",
      externalCalendarId: "callbackiq",
      heldExpiresAt: null,
    });
    expect(Lead.updateOne).toHaveBeenCalledWith(
      { _id: "l1", business: "b1" },
      { $set: { appointment: "a2", bookedAt: replacement.confirmedAt } },
    );
    expect(SocketService.emitToBusiness).toHaveBeenCalledWith("b1", "appointment:rescheduled", { original, replacement });
  });

  test("uses original defaults, a generated key, and skips lead update", async () => {
    const original = appointmentDoc({ status: "confirmed", lead: null, provider: "" });
    const replacement = appointmentDoc({ _id: "a2", lead: null, status: "held" });
    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(null);
    AvailabilityService.getAvailability.mockResolvedValue({ slots: matchingSlots });
    Appointment.create.mockResolvedValue(replacement);
    provider.updateAppointment.mockResolvedValue({});
    await AppointmentService.reschedule({
      business,
      appointmentId: "a1",
      input: { startAt: matchingSlots[0].startAt, endAt: matchingSlots[0].endAt },
    });
    expect(SchedulingProviderFactory.getProvider).toHaveBeenCalledWith(business, "internal");
    expect(replacement.provider).toBe("internal");
    expect(Lead.updateOne).not.toHaveBeenCalled();
  });

  test("marks replacement failed when provider update fails", async () => {
    const original = appointmentDoc({ status: "confirmed" });
    const replacement = appointmentDoc({ _id: "a2", status: "held" });
    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(null);
    AvailabilityService.getAvailability.mockResolvedValue({ slots: matchingSlots });
    Appointment.create.mockResolvedValue(replacement);
    const error = new Error("update failed");
    provider.updateAppointment.mockRejectedValue(error);
    await expect(
      AppointmentService.reschedule({
        business,
        appointmentId: "a1",
        input: { startAt: matchingSlots[0].startAt, endAt: matchingSlots[0].endAt },
      }),
    ).rejects.toBe(error);
    expect(replacement).toMatchObject({
      status: "held",
      activeSlotKey: "slot",
      failureReason: expect.stringContaining(
        "Provider update failed or outcome is uncertain; same-key retry required",
      ),
    });
    expect(InterventionService.integrationFailure).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: "a2", error }));
  });

  test("updates allowed fields and normalizes an address", async () => {
    const appointment = appointmentDoc({ status: "confirmed" });
    Appointment.findOne.mockResolvedValue(appointment);
    const result = await AppointmentService.update({
      businessId: "b1",
      appointmentId: "a1",
      changes: {
        customerName: "Updated",
        customerPhone: "+2",
        customerEmail: "new@example.com",
        address: { street: " A ", city: " B ", state: " C ", postalCode: " 12345 " },
        notes: "new",
        estimatedValue: 400,
        actualRevenue: 350,
        ignored: "no",
      },
    });
    expect(result).toMatchObject({
      customerName: "Updated",
      address: { street: "A", city: "B", state: "C", postalCode: "12345" },
      actualRevenue: 350,
    });
    expect(result).not.toHaveProperty("ignored");
  });

  test("completes a job, records revenue, and updates its lead", async () => {
    const appointment = appointmentDoc({ status: "confirmed", actualRevenue: 500 });
    Appointment.findOne.mockResolvedValue(appointment);
    await AppointmentService.update({
      businessId: "b1",
      appointmentId: "a1",
      changes: { status: "completed" },
    });
    expect(appointment.completedAt).toBeInstanceOf(Date);
    expect(appointment.activeSlotKey).toBeNull();
    expect(ConversionEventService.record).toHaveBeenCalledWith(expect.objectContaining({ type: "job_completed", actualRevenue: 500 }));
    expect(Lead.updateOne).toHaveBeenCalledWith(
      { _id: "l1", business: "b1" },
      { $set: { completedAt: appointment.completedAt, actualRevenue: 500 } },
    );
  });

  test("marks no-shows without recording completion and handles no lead", async () => {
    const appointment = appointmentDoc({ status: "confirmed", lead: null });
    Appointment.findOne.mockResolvedValue(appointment);
    await AppointmentService.update({ businessId: "b1", appointmentId: "a1", changes: { status: "no_show" } });
    expect(appointment.noShowAt).toBeInstanceOf(Date);
    expect(ConversionEventService.record).not.toHaveBeenCalled();
    expect(Lead.updateOne).not.toHaveBeenCalled();
  });

  test("requires dedicated endpoints for status changes and rejects invalid transitions", async () => {
    Appointment.findOne.mockResolvedValueOnce(appointmentDoc({ status: "confirmed" }));
    await expect(
      AppointmentService.update({ businessId: "b1", appointmentId: "a1", changes: { status: "canceled" } }),
    ).rejects.toMatchObject({ statusCode: 400 });

    Appointment.findOne.mockResolvedValueOnce(appointmentDoc({ status: "canceled" }));
    await expect(
      AppointmentService.update({ businessId: "b1", appointmentId: "a1", changes: { status: "completed" } }),
    ).rejects.toMatchObject({ code: "INVALID_APPOINTMENT_TRANSITION" });
  });

  test("does not transition when status is unchanged", async () => {
    const appointment = appointmentDoc({ status: "confirmed" });
    Appointment.findOne.mockResolvedValue(appointment);
    await expect(
      AppointmentService.update({ businessId: "b1", appointmentId: "a1", changes: { status: "confirmed" } }),
    ).resolves.toBe(appointment);
  });

  test("builds filtered, bounded list queries and populates results", () => {
    const chain = populateChain();
    Appointment.find.mockReturnValue(chain);
    const result = AppointmentService.list({
      businessId: "b1",
      query: {
        status: "confirmed",
        leadId: "l1",
        conversationId: "c1",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        limit: 999,
        skip: -5,
      },
    });
    expect(result).toBe(chain);
    expect(Appointment.find).toHaveBeenCalledWith({
      business: "b1",
      status: "confirmed",
      lead: "l1",
      conversation: "c1",
      startAt: { $gte: new Date("2026-07-01"), $lte: new Date("2026-07-31") },
    });
    expect(chain.limit).toHaveBeenCalledWith(200);
    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.populate).toHaveBeenCalledTimes(5);
  });

  test("uses list defaults and supports a one-sided date range", () => {
    const chain = populateChain();
    Appointment.find.mockReturnValue(chain);
    AppointmentService.list({ businessId: "b1", query: { startDate: "2026-07-01", limit: 0, skip: 10 } });
    expect(Appointment.find.mock.calls[0][0].startAt).toEqual({ $gte: new Date("2026-07-01") });
    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(chain.skip).toHaveBeenCalledWith(10);
  });

  test("gets and populates one appointment", () => {
    const chain = populateChain();
    Appointment.findOne.mockReturnValue(chain);
    expect(AppointmentService.get({ businessId: "b1", appointmentId: "a1" })).toBe(chain);
    expect(Appointment.findOne).toHaveBeenCalledWith({ _id: "a1", business: "b1" });
    expect(chain.populate).toHaveBeenCalledTimes(5);
  });
});
