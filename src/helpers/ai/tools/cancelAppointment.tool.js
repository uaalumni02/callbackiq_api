import AppointmentService from "../../../services/scheduling/appointment.service.js";

export const cancelAppointmentTool = ({ business, appointmentId, reason }) =>
  AppointmentService.cancel({ business, appointmentId, reason, notifyCustomer: false });

export default cancelAppointmentTool;
