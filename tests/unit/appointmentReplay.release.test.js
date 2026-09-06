import Appointment from "../../src/models/appointment.js";
import AppointmentService from "../../src/services/scheduling/appointment.service.js";

jest.mock("../../src/models/appointment.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

describe("release invariant: appointment create replay preserves real state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("replays a non-approval held create through confirmation", async () => {
    const held = {
      _id: "a1",
      status: "held",
      requiresBusinessApproval: false,
    };
    Appointment.findOne.mockResolvedValueOnce(held);
    const confirm = jest
      .spyOn(AppointmentService, "confirm")
      .mockResolvedValueOnce({ ...held, status: "confirmed" });

    const result = await AppointmentService.create({
      business: { _id: "b1" },
      input: { customerPhone: "+14045550123" },
      idempotencyKey: "same-request",
      confirm: true,
    });

    expect(confirm).toHaveBeenCalledWith({
      business: { _id: "b1" },
      appointmentId: "a1",
    });
    expect(result.status).toBe("confirmed");
  });

  test("does not auto-confirm an AI hold that still requires business approval", async () => {
    const held = {
      _id: "a2",
      status: "held",
      requiresBusinessApproval: true,
    };
    Appointment.findOne.mockResolvedValueOnce(held);
    const confirm = jest.spyOn(AppointmentService, "confirm");

    const result = await AppointmentService.create({
      business: { _id: "b1" },
      input: { customerPhone: "+14045550123" },
      idempotencyKey: "approval-request",
      confirm: true,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBe(held);
  });

  test("does not silently replay a failed create as success", async () => {
    Appointment.findOne.mockResolvedValueOnce({
      _id: "a3",
      status: "failed",
      requiresBusinessApproval: false,
    });

    await expect(
      AppointmentService.create({
        business: { _id: "b1" },
        input: { customerPhone: "+14045550123" },
        idempotencyKey: "failed-request",
        confirm: true,
      }),
    ).rejects.toMatchObject({
      code: "APPOINTMENT_IDEMPOTENCY_REPLAY_FINAL_STATE",
      statusCode: 409,
      existingStatus: "failed",
    });
  });
});
