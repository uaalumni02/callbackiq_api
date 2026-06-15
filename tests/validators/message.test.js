import messageSchema from "../../src/validator/message.js";

describe("Message Validator", () => {
  test("valid outbound message passes", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hi, sorry we missed your call. What service do you need?",
      provider: "manual",
      status: "sent",
    };

    const result = await messageSchema.validateAsync(data);

    expect(result.direction).toBe("outbound");
    expect(result.body).toBe(data.body);
  });

  test("message fails without conversation", async () => {
    const data = {
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails with invalid direction", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "sideways",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails with empty body", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });
});
