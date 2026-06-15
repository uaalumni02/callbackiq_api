import leadSchema from "../../src/validator/lead.js";

describe("Lead Validator", () => {
  test("valid lead data passes", async () => {
    const data = {
      customerName: "John Smith",
      phone: "4045551234",
      email: "john@example.com",
      serviceNeeded: "Water heater repair",
      urgency: "emergency",
      address: "123 Main St Atlanta GA",
      preferredAppointmentTime: "Today after 3 PM",
      leadQualityScore: 90,
      estimatedValue: 850,
      status: "new",
      source: "manual",
    };

    const result = await leadSchema.validateAsync(data);

    expect(result.customerName).toBe(data.customerName);
    expect(result.urgency).toBe("emergency");
    expect(result.status).toBe("new");
  });

  test("lead fails without phone", async () => {
    const data = {
      serviceNeeded: "Water heater repair",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails without serviceNeeded", async () => {
    const data = {
      phone: "4045551234",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails with invalid status", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      status: "pending",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });
});
