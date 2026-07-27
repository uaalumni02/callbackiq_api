import SchedulingProvider from "./schedulingProvider.js";

class ServiceTitanProvider extends SchedulingProvider {
  notConfigured() {
    const error = new Error("ServiceTitan scheduling is not configured yet.");
    error.statusCode = 409;
    error.code = "PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  async getAvailability() { return this.notConfigured(); }
  async createAppointment() { return this.notConfigured(); }
  async updateAppointment() { return this.notConfigured(); }
  async cancelAppointment() { return this.notConfigured(); }
  async getAppointment() { return this.notConfigured(); }
  async testConnection() { return this.notConfigured(); }
}

export default ServiceTitanProvider;
