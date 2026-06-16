import callLogSchema from "../../src/validator/callLog.js";

describe("Call Log Validator", () => {
  test("valid missed call log passes", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      direction: "inbound",
      status: "missed",
      durationSeconds: 0,
      provider: "manual",
      providerCallId: "CA123",
      recordingUrl: "",
      transcription: "",
      missedCallTextSent: false,
      recovered: false,
      notes: "Missed call from potential plumbing customer.",
    };

    const result = await callLogSchema.validateAsync(data);

    expect(result.from).toBe("4045551234");
    expect(result.to).toBe("4041112222");
    expect(result.direction).toBe("inbound");
    expect(result.status).toBe("missed");
    expect(result.durationSeconds).toBe(0);
    expect(result.provider).toBe("manual");
    expect(result.missedCallTextSent).toBe(false);
    expect(result.recovered).toBe(false);
  });

  test("valid answered outbound call log passes", async () => {
    const data = {
      from: "4041112222",
      to: "4045551234",
      direction: "outbound",
      status: "answered",
      durationSeconds: 180,
      provider: "twilio",
      recovered: true,
    };

    const result = await callLogSchema.validateAsync(data);

    expect(result.direction).toBe("outbound");
    expect(result.status).toBe("answered");
    expect(result.durationSeconds).toBe(180);
    expect(result.provider).toBe("twilio");
    expect(result.recovered).toBe(true);
  });

  test("defaults are applied", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
    };

    const result = await callLogSchema.validateAsync(data);

    expect(result.direction).toBe("inbound");
    expect(result.status).toBe("missed");
    expect(result.durationSeconds).toBe(0);
    expect(result.provider).toBe("manual");
    expect(result.missedCallTextSent).toBe(false);
    expect(result.recovered).toBe(false);
  });

  test("call log fails without from", async () => {
    const data = {
      to: "4041112222",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails with empty from", async () => {
    const data = {
      from: "",
      to: "4041112222",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails with invalid from phone", async () => {
    const data = {
      from: "bad-phone",
      to: "4041112222",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails without to", async () => {
    const data = {
      from: "4045551234",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails with empty to", async () => {
    const data = {
      from: "4045551234",
      to: "",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails with invalid to phone", async () => {
    const data = {
      from: "4045551234",
      to: "bad-phone",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log allows common phone formats", async () => {
    const validPhones = [
      "4045551234",
      "404-555-1234",
      "(404) 555-1234",
      "+1 404 555 1234",
      "404.555.1234",
    ];

    for (const phone of validPhones) {
      const result = await callLogSchema.validateAsync({
        from: phone,
        to: "4041112222",
      });

      expect(result.from).toBe(phone);
    }
  });

  test("call log fails with invalid direction", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      direction: "sideways",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails with invalid status", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      status: "ignored",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails with invalid provider", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      provider: "google-voice",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("durationSeconds cannot be negative", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      durationSeconds: -1,
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("notes fail when over max length", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      notes: "A".repeat(2001),
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("extra unknown fields are rejected", async () => {
    const data = {
      from: "4045551234",
      to: "4041112222",
      randomField: "should not be allowed",
    };

    await expect(
      callLogSchema.validateAsync(data, { allowUnknown: false }),
    ).rejects.toThrow();
  });
});
