import AppointmentService from "../../../services/scheduling/appointment.service.js";

export const createAppointmentTool = ({ business, input, idempotencyKey }) =>
  AppointmentService.create({
    business,
    input: { ...input, source: "sms", bookedBy: "ai" },
    idempotencyKey,
    confirm: true,
  });

export default createAppointmentTool;
