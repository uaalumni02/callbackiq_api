import conversationSchema from "../../src/validator/conversation.js";

describe("Conversation Validator", () => {
  test("valid conversation data passes", async () => {
    const data = {
      customerPhone: "4045551234",
      customerName: "John Smith",
      status: "open",
    };

    const result = await conversationSchema.validateAsync(data);

    expect(result.customerPhone).toBe("4045551234");
    expect(result.customerName).toBe("John Smith");
    expect(result.status).toBe("open");
  });

  test("default status is open", async () => {
    const data = {
      customerPhone: "4045551234",
    };

    const result = await conversationSchema.validateAsync(data);

    expect(result.status).toBe("open");
  });

  test("conversation fails without customerPhone", async () => {
    const data = {
      customerName: "John Smith",
    };

    await expect(conversationSchema.validateAsync(data)).rejects.toThrow();
  });

  test("conversation fails with empty customerPhone", async () => {
    const data = {
      customerPhone: "",
      customerName: "John Smith",
    };

    await expect(conversationSchema.validateAsync(data)).rejects.toThrow();
  });

  test("conversation fails with invalid customerPhone", async () => {
    const data = {
      customerPhone: "bad-phone",
      customerName: "John Smith",
    };

    await expect(conversationSchema.validateAsync(data)).rejects.toThrow();
  });

  test("conversation allows common phone formats", async () => {
    const validPhones = [
      "4045551234",
      "404-555-1234",
      "(404) 555-1234",
      "+1 404 555 1234",
      "404.555.1234",
    ];

    for (const customerPhone of validPhones) {
      const result = await conversationSchema.validateAsync({
        customerPhone,
        customerName: "John Smith",
      });

      expect(result.customerPhone).toBe(customerPhone);
    }
  });

  test("conversation allows empty customerName", async () => {
    const data = {
      customerPhone: "4045551234",
      customerName: "",
    };

    const result = await conversationSchema.validateAsync(data);

    expect(result.customerName).toBe("");
  });

  test("conversation fails when customerName exceeds max length", async () => {
    const data = {
      customerPhone: "4045551234",
      customerName: "A".repeat(101),
    };

    await expect(conversationSchema.validateAsync(data)).rejects.toThrow();
  });

  test("conversation fails with invalid status", async () => {
    const data = {
      customerPhone: "4045551234",
      status: "pending",
    };

    await expect(conversationSchema.validateAsync(data)).rejects.toThrow();
  });

  test("conversation allows valid statuses", async () => {
    const validStatuses = ["open", "closed", "spam"];

    for (const status of validStatuses) {
      const result = await conversationSchema.validateAsync({
        customerPhone: "4045551234",
        status,
      });

      expect(result.status).toBe(status);
    }
  });

  test("extra unknown fields are rejected", async () => {
    const data = {
      customerPhone: "4045551234",
      randomField: "should not be allowed",
    };

    await expect(
      conversationSchema.validateAsync(data, { allowUnknown: false }),
    ).rejects.toThrow();
  });
});
