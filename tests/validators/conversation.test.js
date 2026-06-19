import conversationSchema from "../../src/validator/conversation.js";

const businessId = "665000000000000000000001";
const leadId = "665000000000000000000002";

describe("Conversation Validator", () => {
  test("valid conversation data passes", async () => {
    const data = {
      business: businessId,
      lead: leadId,
      customerPhone: "4045551234",
      customerName: "John Smith",
      status: "open",
    };

    const value = await conversationSchema.validateAsync(data);

    expect(value.business).toBe(businessId);
    expect(value.lead).toBe(leadId);
    expect(value.customerPhone).toBe("4045551234");
    expect(value.customerName).toBe("John Smith");
    expect(value.status).toBe("open");
  });

  test("business is required", async () => {
    await expect(
      conversationSchema.validateAsync({
        customerPhone: "4045551234",
      }),
    ).rejects.toThrow('"business" is required');
  });

  test("customerPhone is required", async () => {
    await expect(
      conversationSchema.validateAsync({
        business: businessId,
      }),
    ).rejects.toThrow('"customerPhone" is required');
  });

  test("default status is open", async () => {
    const value = await conversationSchema.validateAsync({
      business: businessId,
      customerPhone: "4045551234",
    });

    expect(value.status).toBe("open");
  });

  test("conversation allows common phone formats", async () => {
    const phones = [
      "4045551234",
      "+14045551234",
      "(404) 555-1234",
      "404-555-1234",
      "404 555 1234",
    ];

    for (const phone of phones) {
      const value = await conversationSchema.validateAsync({
        business: businessId,
        customerPhone: phone,
      });

      expect(value.customerPhone).toBe(phone);
    }
  });

  test("conversation allows empty customerName", async () => {
    const value = await conversationSchema.validateAsync({
      business: businessId,
      customerPhone: "4045551234",
      customerName: "",
    });

    expect(value.customerName).toBe("");
  });

  test("conversation allows valid statuses", async () => {
    const statuses = ["open", "closed"];

    for (const status of statuses) {
      const value = await conversationSchema.validateAsync({
        business: businessId,
        customerPhone: "4045551234",
        status,
      });

      expect(value.status).toBe(status);
    }
  });

  test("conversation rejects invalid status", async () => {
    await expect(
      conversationSchema.validateAsync({
        business: businessId,
        customerPhone: "4045551234",
        status: "pending",
      }),
    ).rejects.toThrow();
  });

  test("conversation rejects invalid phone", async () => {
    await expect(
      conversationSchema.validateAsync({
        business: businessId,
        customerPhone: "bad-phone",
      }),
    ).rejects.toThrow();
  });
});
