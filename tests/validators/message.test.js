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

    expect(result.conversation).toBe("665000000000000000000001");
    expect(result.direction).toBe("outbound");
    expect(result.from).toBe("4041112222");
    expect(result.to).toBe("4045551234");
    expect(result.body).toBe(data.body);
    expect(result.provider).toBe("manual");
    expect(result.status).toBe("sent");
  });

  test("valid inbound message passes", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "inbound",
      from: "4045551234",
      to: "4041112222",
      body: "I need help with a leaking pipe.",
      provider: "twilio",
      status: "received",
    };

    const result = await messageSchema.validateAsync(data);

    expect(result.direction).toBe("inbound");
    expect(result.provider).toBe("twilio");
    expect(result.status).toBe("received");
  });

  test("defaults are applied", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
    };

    const result = await messageSchema.validateAsync(data);

    expect(result.provider).toBe("manual");
    expect(result.status).toBe("sent");
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

  test("message fails with empty conversation", async () => {
    const data = {
      conversation: "",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails without direction", async () => {
    const data = {
      conversation: "665000000000000000000001",
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

  test("message fails without from", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      to: "4045551234",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails with invalid from phone", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "bad-phone",
      to: "4045551234",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails without to", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails with invalid to phone", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "bad-phone",
      body: "Hello",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message allows common phone formats", async () => {
    const validPhones = [
      "4045551234",
      "404-555-1234",
      "(404) 555-1234",
      "+1 404 555 1234",
      "404.555.1234",
    ];

    for (const phone of validPhones) {
      const result = await messageSchema.validateAsync({
        conversation: "665000000000000000000001",
        direction: "outbound",
        from: phone,
        to: "4041112222",
        body: "Hello",
      });

      expect(result.from).toBe(phone);
    }
  });

  test("message fails without body", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
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

  test("message fails when body exceeds max length", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "A".repeat(1601),
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails with invalid provider", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
      provider: "carrier-pigeon",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("message fails with invalid status", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
      status: "opened",
    };

    await expect(messageSchema.validateAsync(data)).rejects.toThrow();
  });

  test("extra unknown fields are rejected", async () => {
    const data = {
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4041112222",
      to: "4045551234",
      body: "Hello",
      randomField: "should not be allowed",
    };

    await expect(
      messageSchema.validateAsync(data, { allowUnknown: false }),
    ).rejects.toThrow();
  });
});
