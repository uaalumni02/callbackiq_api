import messageSchema from "../../src/validator/message.js";

const businessId = "665000000000000000000001";
const conversationId = "665000000000000000000002";
const leadId = "665000000000000000000003";

describe("Message Validator", () => {
  test("valid outbound message passes", async () => {
    const data = {
      business: businessId,
      conversation: conversationId,
      lead: leadId,
      direction: "outbound",
      from: "4045551234",
      to: "4045559999",
      body: "Hello customer",
      provider: "manual",
      status: "sent",
    };

    const value = await messageSchema.validateAsync(data);

    expect(value.business).toBe(businessId);
    expect(value.conversation).toBe(conversationId);
    expect(value.lead).toBe(leadId);
    expect(value.direction).toBe("outbound");
    expect(value.provider).toBe("manual");
    expect(value.status).toBe("sent");
  });

  test("valid inbound message passes", async () => {
    const data = {
      business: businessId,
      conversation: conversationId,
      direction: "inbound",
      from: "4045559999",
      to: "4045551234",
      body: "I need help",
      provider: "twilio",
      providerMessageId: "SM123",
      status: "received",
    };

    const value = await messageSchema.validateAsync(data);

    expect(value.business).toBe(businessId);
    expect(value.direction).toBe("inbound");
    expect(value.status).toBe("received");
  });

  test("business is required", async () => {
    await expect(
      messageSchema.validateAsync({
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      }),
    ).rejects.toThrow('"business" is required');
  });

  test("conversation is required", async () => {
    await expect(
      messageSchema.validateAsync({
        business: businessId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      }),
    ).rejects.toThrow('"conversation" is required');
  });

  test("defaults are applied", async () => {
    const value = await messageSchema.validateAsync({
      business: businessId,
      conversation: conversationId,
      direction: "outbound",
      from: "4045551234",
      to: "4045559999",
      body: "Hello",
    });

    expect(value.provider).toBe("manual");
    expect(value.status).toBe("sent");
  });

  test("message allows common phone formats", async () => {
    const phones = [
      "4045551234",
      "+14045551234",
      "(404) 555-1234",
      "404-555-1234",
      "404 555 1234",
    ];

    for (const phone of phones) {
      const value = await messageSchema.validateAsync({
        business: businessId,
        conversation: conversationId,
        direction: "outbound",
        from: phone,
        to: "4045559999",
        body: "Hello",
      });

      expect(value.from).toBe(phone);
    }
  });

  test("message rejects invalid direction", async () => {
    await expect(
      messageSchema.validateAsync({
        business: businessId,
        conversation: conversationId,
        direction: "sideways",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      }),
    ).rejects.toThrow();
  });

  test("message rejects empty body", async () => {
    await expect(
      messageSchema.validateAsync({
        business: businessId,
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "",
      }),
    ).rejects.toThrow();
  });
});
