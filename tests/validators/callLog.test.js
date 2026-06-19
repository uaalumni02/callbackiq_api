import callLogSchema from "../../src/validator/callLog.js";

const businessId = "665000000000000000000001";
const leadId = "665000000000000000000002";
const conversationId = "665000000000000000000003";

describe("Call Log Validator", () => {
  test("valid missed call log passes", async () => {
    const data = {
      business: businessId,
      lead: leadId,
      conversation: conversationId,
      from: "4045559999",
      to: "4045551234",
      direction: "inbound",
      status: "missed",
      durationSeconds: 0,
      provider: "manual",
      notes: "Missed customer call.",
    };

    const value = await callLogSchema.validateAsync(data);

    expect(value.business).toBe(businessId);
    expect(value.lead).toBe(leadId);
    expect(value.conversation).toBe(conversationId);
    expect(value.status).toBe("missed");
  });

  test("valid answered outbound call log passes", async () => {
    const data = {
      business: businessId,
      from: "4045551234",
      to: "4045559999",
      direction: "outbound",
      status: "answered",
      durationSeconds: 180,
      provider: "twilio",
      providerCallId: "CA123",
      recordingUrl: "https://example.com/recording.mp3",
      transcription: "Customer requested service.",
      missedCallTextSent: true,
      recovered: true,
      notes: "Recovered call.",
    };

    const value = await callLogSchema.validateAsync(data);

    expect(value.business).toBe(businessId);
    expect(value.direction).toBe("outbound");
    expect(value.status).toBe("answered");
    expect(value.durationSeconds).toBe(180);
  });

  test("business is required", async () => {
    await expect(
      callLogSchema.validateAsync({
        from: "4045559999",
        to: "4045551234",
      }),
    ).rejects.toThrow('"business" is required');
  });

  test("defaults are applied", async () => {
    const value = await callLogSchema.validateAsync({
      business: businessId,
      from: "4045559999",
      to: "4045551234",
    });

    expect(value.direction).toBe("inbound");
    expect(value.status).toBe("missed");
    expect(value.durationSeconds).toBe(0);
    expect(value.provider).toBe("manual");
    expect(value.missedCallTextSent).toBe(false);
    expect(value.recovered).toBe(false);
  });

  test("call log allows common phone formats", async () => {
    const phones = [
      "4045551234",
      "+14045551234",
      "(404) 555-1234",
      "404-555-1234",
      "404 555 1234",
    ];

    for (const phone of phones) {
      const value = await callLogSchema.validateAsync({
        business: businessId,
        from: phone,
        to: "4045559999",
      });

      expect(value.from).toBe(phone);
    }
  });

  test("call log rejects invalid status", async () => {
    await expect(
      callLogSchema.validateAsync({
        business: businessId,
        from: "4045559999",
        to: "4045551234",
        status: "ignored",
      }),
    ).rejects.toThrow();
  });

  test("call log rejects invalid phone", async () => {
    await expect(
      callLogSchema.validateAsync({
        business: businessId,
        from: "bad-phone",
        to: "4045551234",
      }),
    ).rejects.toThrow();
  });
});
