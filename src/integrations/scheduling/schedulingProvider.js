export class SchedulingProvider {
  constructor({ business }) {
    if (!business) {
      throw new Error("A business is required to initialize a scheduling provider.");
    }

    this.business = business;
  }

  async getAvailability() {
    throw new Error("getAvailability() must be implemented by the provider.");
  }

  async createAppointment() {
    throw new Error("createAppointment() must be implemented by the provider.");
  }

  async updateAppointment() {
    throw new Error("updateAppointment() must be implemented by the provider.");
  }

  async cancelAppointment() {
    throw new Error("cancelAppointment() must be implemented by the provider.");
  }

  async getAppointment() {
    throw new Error("getAppointment() must be implemented by the provider.");
  }

  async testConnection() {
    throw new Error("testConnection() must be implemented by the provider.");
  }
}

export default SchedulingProvider;
