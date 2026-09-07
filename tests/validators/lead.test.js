import leadSchema from "../../src/validator/lead.js";

describe("Lead Validator", () => {
  test("valid emergency lead data passes", async () => {
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
      summary: "Customer needs emergency water heater repair today.",
      notes: "High-value urgent job.",
    };

    const result = await leadSchema.validateAsync(data);

    expect(result.customerName).toBe("John Smith");
    expect(result.phone).toBe("4045551234");
    expect(result.email).toBe("john@example.com");
    expect(result.serviceNeeded).toBe("Water heater repair");
    expect(result.urgency).toBe("emergency");
    expect(result.leadQualityScore).toBe(90);
    expect(result.estimatedValue).toBe(850);
    expect(result.status).toBe("new");
    expect(result.source).toBe("manual");
  });

  test("defaults are applied", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
    };

    const result = await leadSchema.validateAsync(data);

    expect(result.urgency).toBe("medium");
    expect(result.leadQualityScore).toBe(50);
    expect(result.estimatedValue).toBeUndefined();
    expect(result.status).toBe("new");
    expect(result.source).toBe("manual");
  });

  test("lead fails without phone", async () => {
    const data = {
      serviceNeeded: "Water heater repair",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails with empty phone", async () => {
    const data = {
      phone: "",
      serviceNeeded: "Water heater repair",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails with invalid phone", async () => {
    const data = {
      phone: "abc123",
      serviceNeeded: "Water heater repair",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead allows common phone formats", async () => {
    const validPhones = [
      "4045551234",
      "404-555-1234",
      "(404) 555-1234",
      "+1 404 555 1234",
      "404.555.1234",
    ];

    for (const phone of validPhones) {
      const result = await leadSchema.validateAsync({
        phone,
        serviceNeeded: "Water heater repair",
      });

      expect(result.phone).toBe(phone);
    }
  });

  test("lead fails without serviceNeeded", async () => {
    const data = {
      phone: "4045551234",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails with empty serviceNeeded", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails when serviceNeeded exceeds max length", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "A".repeat(201),
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead fails with invalid email", async () => {
    const data = {
      phone: "4045551234",
      email: "bad-email",
      serviceNeeded: "Water heater repair",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("lead allows empty optional email", async () => {
    const data = {
      phone: "4045551234",
      email: "",
      serviceNeeded: "Water heater repair",
    };

    const result = await leadSchema.validateAsync(data);

    expect(result.email).toBe("");
  });

  test("lead fails with invalid urgency", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      urgency: "critical",
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

  test("lead fails with invalid source", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      source: "facebook",
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("leadQualityScore cannot be negative", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      leadQualityScore: -1,
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("leadQualityScore cannot be greater than 100", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      leadQualityScore: 101,
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("estimatedValue cannot be negative", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      estimatedValue: -100,
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("summary fails when over max length", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      summary: "A".repeat(1001),
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("notes fails when over max length", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      notes: "A".repeat(2001),
    };

    await expect(leadSchema.validateAsync(data)).rejects.toThrow();
  });

  test("extra unknown fields are rejected", async () => {
    const data = {
      phone: "4045551234",
      serviceNeeded: "Water heater repair",
      randomField: "should not be allowed",
    };

    await expect(
      leadSchema.validateAsync(data, { allowUnknown: false }),
    ).rejects.toThrow();
  });
});
