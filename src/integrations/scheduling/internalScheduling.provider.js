import SchedulingProvider from "./schedulingProvider.js";
import { generateInternalSlots } from "../../services/scheduling/slotGenerator.service.js";

class InternalSchedulingProvider extends SchedulingProvider {
  async getAvailability(options) {
    return generateInternalSlots({ ...options, business: this.business });
  }

  async createAppointment({ appointment }) {
    return {
      provider: "internal",
      externalAppointmentId: `internal:${appointment._id}`,
      externalCalendarId: "callbackiq",
      raw: null,
    };
  }

  async updateAppointment({ appointment, changes }) {
    return {
      provider: "internal",
      externalAppointmentId:
        appointment.externalAppointmentId || `internal:${appointment._id}`,
      externalCalendarId: "callbackiq",
      changes,
      raw: null,
    };
  }

  async cancelAppointment({ appointment }) {
    return {
      provider: "internal",
      externalAppointmentId:
        appointment.externalAppointmentId || `internal:${appointment._id}`,
      canceled: true,
    };
  }

  async getAppointment({ appointment }) {
    return appointment;
  }

  async testConnection() {
    return { connected: true, provider: "internal" };
  }
}

export default InternalSchedulingProvider;
