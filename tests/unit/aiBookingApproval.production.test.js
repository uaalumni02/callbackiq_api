import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import AlertService from "../../src/services/alert.service.js";
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";
import {
  getBookableService,
  getSchedulingPolicy,
} from "../../src/services/scheduling/appointmentPolicy.service.js";

jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

jest.mock("../../src/services/alert.service.js", () => ({
  __esModule: true,
  default: { createSystemAlert: jest.fn() },
}));

jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getSchedulingPolicy: jest.fn(),
  getBookableService: jest.fn(),
}));

describe("AI appointment business-approval invariant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSchedulingPolicy.mockResolvedValue({
      aiBookingConfirmationMode: "auto",
      manualApprovalHoldMinutes: 30,
    });
    getBookableService.mockResolvedValue({
      _id: "service-1",
      requiresHumanReview: false,
      aiCanBook: true,
    });
    AppointmentService.create.mockResolvedValue({
      _id: "appointment-1",
      status: "held",
      requiresBusinessApproval: true,
      heldExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    AlertService.createSystemAlert.mockResolvedValue({});
  });

  test("AI can only create a held request, even if a legacy policy says auto", async () => {
    await createAppointmentTool({
      business: { _id: "business-1" },
      input: {
        customerPhone: "+14045550100",
        serviceOfferingId: "service-1",
        source: "voice",
      },
      idempotencyKey: "ai-request-1",
    });

    expect(AppointmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        confirm: false,
        input: expect.objectContaining({
          bookedBy: "ai",
          source: "voice",
          requiresBusinessApproval: true,
          holdMinutes: 30,
        }),
      }),
    );
  });

  test("creates a durable business alert for every held AI appointment request", async () => {
    await createAppointmentTool({
      business: { _id: "business-1" },
      input: {
        customerPhone: "+14045550100",
        serviceOfferingId: "service-1",
        source: "sms",
        lead: "lead-1",
        conversation: "conversation-1",
        startAt: new Date("2026-09-08T14:00:00.000Z"),
      },
      idempotencyKey: "ai-request-2",
    });

    expect(AlertService.createSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        title: "Appointment approval required",
        dedupeKey: "appointment_approval_required:appointment-1",
      }),
    );
  });
});
