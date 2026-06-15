import businessSchema from "../../src/validator/business.js";

describe("Business Validator", () => {
  test("valid business data passes", async () => {
    const data = {
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "4045551234",
      email: "owner@atlantaproplumbing.com",
      website: "https://atlantaproplumbing.com",
      city: "Atlanta",
      state: "GA",
      estimatedJobValue: 800,
    };

    const result = await businessSchema.validateAsync(data);

    expect(result.businessName).toBe(data.businessName);
    expect(result.businessType).toBe("plumbing");
  });

  test("business fails without businessName", async () => {
    const data = {
      businessType: "plumbing",
      phone: "4045551234",
    };

    await expect(businessSchema.validateAsync(data)).rejects.toThrow();
  });

  test("business fails with invalid businessType", async () => {
    const data = {
      businessName: "Bad Business",
      businessType: "restaurant",
      phone: "4045551234",
    };

    await expect(businessSchema.validateAsync(data)).rejects.toThrow();
  });

  test("business fails with invalid phone", async () => {
    const data = {
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "abc123",
    };

    await expect(businessSchema.validateAsync(data)).rejects.toThrow();
  });
});
