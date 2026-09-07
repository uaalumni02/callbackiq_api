import Appointment from "../../src/models/appointment.js";
import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import {
  getBookableService,
  getSlotCapacity,
} from "../../src/services/scheduling/appointmentPolicy.service.js";
import SchedulingProviderFactory from "../../src/services/scheduling/schedulingProviderFactory.js";
import InterventionService from "../../src/services/intervention.service.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock("../../src/services/scheduling/availability.service.js", () => ({
  __esModule: true,
  default: {
    getAvailability: jest.fn(),
  },
}));
jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getAiBookableService: jest.fn(),
  getBookableService: jest.fn(),
  getSlotCapacity: jest.fn(),
}));
jest.mock("../../src/services/scheduling/schedulingProviderFactory.js", () => ({
  __esModule: true,
  default: {
    getProvider: jest.fn(),
  },
}));
jest.mock("../../src/services/intervention.service.js", () => ({
  __esModule: true,
  default: {
    create: jest.fn().mockResolvedValue(null),
    integrationFailure: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../src/services/automation/automationTrigger.service.js", () => ({
  __esModule: true,
  default: {
    schedule: jest.fn(),
  },
}));
jest.mock("../../src/services/conversionEvent.service.js", () => ({
  __esModule: true,
  default: {
    record: jest.fn(),
  },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitToBusiness: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));
jest.mock("../../src/services/scheduling/appointmentNotification.service.js", () => ({
  __esModule: true,
  cancelAppointmentNotifications: jest.fn(),
  scheduleAppointmentChangeNotice: jest.fn(),
  scheduleAppointmentReminders: jest.fn(),
  schedulePostAppointmentFollowUp: jest.fn(),
}));

const startAt = new Date("2026-09-10T14:00:00.000Z");
const endAt = new Date("2026-09-10T15:30:00.000Z");

const originalAppointment = () => ({
  _id: "original-1",
  business: "b1",
  status: "confirmed",
  serviceOffering: "service-1",
  customerName: "Customer",
  customerPhone: "+14045550123",
  customerEmail: "",
  address: { postalCode: "30303" },
  timezone: "America/New_York",
  source: "manual",
  bookedBy: "staff",
  estimatedValue: 1000,
  provider: "google_calendar",
  externalAppointmentId: "google-event-1",
  externalCalendarId: "calendar-1",
  activeSlotKey: "old-slot",
  slotClaimKeys: ["old-claim"],
  capacityLane: 1,
  save: jest.fn().mockResolvedValue(undefined),
});

describe("release invariant: reschedule retries converge without duplicate provider state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getBookableService.mockResolvedValue({
      _id: "service-1",
      durationMinutes: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      estimatedValue: 1000,
    });
    getSlotCapacity.mockResolvedValue(1);
    AvailabilityService.getAvailability.mockResolvedValue({
      slots: [{ startAt, endAt }],
    });
  });

  test("lost response replay returns confirmed replacement and repairs original", async () => {
    const original = originalAppointment();
    const replacement = {
      _id: "replacement-1",
      business: "b1",
      status: "confirmed",
      rescheduledFrom: original._id,
      startAt,
      endAt,
    };

    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);

    const result = await AppointmentService.reschedule({
      business: { _id: "b1" },
      appointmentId: original._id,
      input: { startAt, endAt },
      idempotencyKey: "reschedule-key",
    });

    expect(result).toBe(replacement);
    expect(original.status).toBe("rescheduled");
    expect(original.rescheduledTo).toBe(replacement._id);
    expect(original.externalAppointmentId).toBeNull();
    expect(original.save).toHaveBeenCalledTimes(1);
    expect(SchedulingProviderFactory.getProvider).not.toHaveBeenCalled();
  });

  test("same-key retry resumes a staged provider-event handoff without mutating the provider twice", async () => {
    const original = originalAppointment();

    // Simulate a process failure after the original released its unique
    // provider linkage but before the replacement was promoted.
    original.externalAppointmentId = null;
    original.externalCalendarId = null;

    const replacement = {
      _id: "replacement-staged-handoff",
      business: "b1",
      status: "held",
      rescheduledFrom: original._id,
      startAt,
      endAt,
      address: { postalCode: "30303" },
      activeSlotKey: "new-slot",
      slotClaimKeys: ["new-claim"],
      capacityLane: 1,
      heldExpiresAt: new Date("2026-09-10T13:30:00.000Z"),
      provider: "google_calendar",
      externalAppointmentId: null,
      externalCalendarId: null,
      pendingRescheduleExternalAppointmentId: "google-event-1",
      pendingRescheduleExternalCalendarId: "calendar-1",
      save: jest.fn().mockResolvedValue(undefined),
    };

    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);

    const provider = {
      updateAppointment: jest.fn(),
    };
    SchedulingProviderFactory.getProvider.mockReturnValue(provider);

    const result = await AppointmentService.reschedule({
      business: {
        _id: "b1",
        timezone: "America/New_York",
      },
      appointmentId: original._id,
      input: {
        startAt,
        endAt,
        address: { postalCode: "30303" },
      },
      idempotencyKey: "reschedule-staged-handoff",
    });

    expect(result).toBe(replacement);

    // The external calendar was already updated before the simulated crash.
    // Recovery must finish only the local handoff.
    expect(provider.updateAppointment).not.toHaveBeenCalled();

    expect(replacement.status).toBe("confirmed");
    expect(replacement.externalAppointmentId).toBe("google-event-1");
    expect(replacement.externalCalendarId).toBe("calendar-1");
    expect(
      replacement.pendingRescheduleExternalAppointmentId
    ).toBeNull();
    expect(
      replacement.pendingRescheduleExternalCalendarId
    ).toBeNull();

    expect(original.status).toBe("rescheduled");
    expect(original.rescheduledTo).toBe(replacement._id);
    expect(original.activeSlotKey).toBeNull();
    expect(original.slotClaimKeys).toEqual([]);
    expect(original.externalAppointmentId).toBeNull();

    expect(replacement.save).toHaveBeenCalledTimes(1);
    expect(original.save).toHaveBeenCalledTimes(1);
    expect(InterventionService.create).not.toHaveBeenCalled();
  });

  test("uncertain provider outcome retains the replacement slot claim for same-key retry", async () => {
    const original = originalAppointment();
    const replacement = {
      _id: "replacement-2",
      business: "b1",
      status: "held",
      startAt,
      endAt,
      address: { postalCode: "30303" },
      activeSlotKey: "new-slot",
      slotClaimKeys: ["new-claim"],
      capacityLane: 1,
      heldExpiresAt: new Date("2026-09-10T13:30:00.000Z"),
      save: jest.fn().mockResolvedValue(undefined),
    };

    Appointment.findOne
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(null);
    Appointment.create.mockResolvedValueOnce(replacement);

    const provider = {
      updateAppointment: jest.fn().mockRejectedValue(
        Object.assign(new Error("provider timeout"), { code: "ETIMEDOUT" }),
      ),
    };
    SchedulingProviderFactory.getProvider.mockReturnValue(provider);

    await expect(
      AppointmentService.reschedule({
        business: { _id: "b1", timezone: "America/New_York" },
        appointmentId: original._id,
        input: {
          startAt,
          endAt,
          address: { postalCode: "30303" },
        },
        idempotencyKey: "reschedule-uncertain",
      }),
    ).rejects.toMatchObject({
      code: "RESCHEDULE_PROVIDER_OUTCOME_UNCERTAIN",
    });

    expect(replacement.status).toBe("held");
    expect(replacement.activeSlotKey).toBe("new-slot");
    expect(replacement.slotClaimKeys).toEqual(["new-claim"]);
    expect(replacement.capacityLane).toBe(1);
    expect(InterventionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "high",
        dedupeKey: expect.stringContaining("reschedule_reconciliation"),
      }),
    );
  });
});
