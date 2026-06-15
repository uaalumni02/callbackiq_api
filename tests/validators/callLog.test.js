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
      missedCallTextSent: false,
      recovered: false,
      notes: "Missed call from potential plumbing customer.",
    };

    const result = await callLogSchema.validateAsync(data);

    expect(result.from).toBe(data.from);
    expect(result.status).toBe("missed");
  });

  test("call log fails without from", async () => {
    const data = {
      to: "4041112222",
      direction: "inbound",
      status: "missed",
    };

    await expect(callLogSchema.validateAsync(data)).rejects.toThrow();
  });

  test("call log fails without to", async () => {
    const data = {
      from: "4045551234",
      direction: "inbound",
      status: "missed",
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
});
