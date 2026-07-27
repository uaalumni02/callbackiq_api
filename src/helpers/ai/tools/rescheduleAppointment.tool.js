import AppointmentService from "../../../services/scheduling/appointment.service.js";

export const rescheduleAppointmentTool = ({
  business,
  appointmentId,
  input,
  idempotencyKey,
}) =>
  AppointmentService.reschedule({
    business,
    appointmentId,
    input: { ...input, source: "sms", bookedBy: "ai" },
    idempotencyKey,
  });

export default rescheduleAppointmentTool;
