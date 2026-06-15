import conversationSchema from "../../src/validator/conversation.js";

describe("Conversation Validator", () => {
  test("valid conversation data passes", async () => {
    const data = {
      customerPhone: "4045551234",
      customerName: "John Smith",
      status: "open",
    };

    const result = await conversationSchema.validateAsync(data);

    expect(result.customerPhone).toBe(data.customerPhone);
    expect(result.status).toBe("open");
  });

  test("conversation fails without customerPhone", async () => {
    const data = {
      customerName: "John Smith",
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
});
