import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import createAppointmentTool from "../../src/helpers/ai/tools/createAppointment.tool.js";

jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

jest.mock("../../src/services/scheduling/appointmentPolicy.service.js", () => ({
  __esModule: true,
  getSchedulingPolicy: jest.fn().mockResolvedValue({
    aiBookingConfirmationMode: "automatic",
    manualApprovalHoldMinutes: 30,
  }),
  getBookableService: jest.fn().mockResolvedValue({
    _id: "service-1",
    requiresHumanReview: false,
    aiCanBook: true,
  }),
}));

const appointmentPolicyMockForCreateAppointmentRelease =
  jest.requireMock(
    "../../src/services/scheduling/appointmentPolicy.service.js",
  );

appointmentPolicyMockForCreateAppointmentRelease.getAiBookableService =
  appointmentPolicyMockForCreateAppointmentRelease.getBookableService;

describe("createAppointmentTool source attribution", () => {
  beforeEach(() => jest.clearAllMocks());

  test("preserves voice as the appointment source", async () => {
    AppointmentService.create.mockResolvedValue({ _id: "appointment-1" });

    await createAppointmentTool({
      business: { _id: "business-1" },
      input: { source: "voice", customerPhone: "+14045550100" },
      idempotencyKey: "voice-booking-1",
    });

    expect(AppointmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          source: "voice",
          bookedBy: "ai",
        }),
      }),
    );
  });

  test("keeps SMS as the backward-compatible default", async () => {
    AppointmentService.create.mockResolvedValue({ _id: "appointment-2" });

    await createAppointmentTool({
      business: { _id: "business-1" },
      input: { customerPhone: "+14045550100" },
      idempotencyKey: "sms-booking-1",
    });

    expect(AppointmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ source: "sms" }),
      }),
    );
  });
});
