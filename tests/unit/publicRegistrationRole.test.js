import { registerSchema } from "../../src/validator/auth.js";

const baseRegistration = {
  userName: "owner1",
  email: "owner@example.com",
  password: "Password123",
  businessName: "Atlanta Plumbing",
  businessPhone: "4045551212",
  businessType: "plumbing",
  smsConsent: true,
  termsAccepted: true,
  privacyAccepted: true,
};

describe("public registration role security", () => {
  test("defaults public registration to owner", async () => {
    const value = await registerSchema.validateAsync(baseRegistration);
    expect(value.role).toBe("owner");
  });

  test("rejects a caller attempting to self-register as admin", async () => {
    await expect(
      registerSchema.validateAsync({ ...baseRegistration, role: "admin" }),
    ).rejects.toThrow(/role/i);
  });

  test("rejects a caller attempting to self-register as member", async () => {
    await expect(
      registerSchema.validateAsync({ ...baseRegistration, role: "member" }),
    ).rejects.toThrow(/role/i);
  });
});
