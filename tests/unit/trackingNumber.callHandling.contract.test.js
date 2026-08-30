import TrackingNumber from "../../src/models/trackingNumber.js";

describe("TrackingNumber call handling", () => {
  test("defaults marketing tracking to forward-first without SMS", () => {
    const number = new TrackingNumber({
      business: "507f1f77bcf86cd799439011",
      phoneNumber: "+14045550123",
      kind: "marketing",
    });

    expect(number.callHandlingMode).toBe("forward");
    expect(number.smsEnabled).toBe(false);
    expect(number.smsRecoveryEnabled).toBe(false);
    expect(number.voiceAiEnabled).toBe(false);
  });

  test("does not disable SMS by default for primary tracking numbers", () => {
    const number = new TrackingNumber({
      business: "507f1f77bcf86cd799439011",
      phoneNumber: "+14045550124",
      kind: "primary",
      isPrimary: true,
    });

    expect(number.smsEnabled).toBe(true);
  });
});
