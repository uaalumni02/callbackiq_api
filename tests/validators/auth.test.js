import { registerSchema, loginSchema } from "../../src/validator/auth.js";

describe("Auth Validator", () => {
  test("valid register data passes", async () => {
    const data = {
      userName: "demoowner",
      email: "owner@callbackiq.com",
      password: "Password123",
      businessName: "Atlanta Pro Plumbing",
      businessPhone: "4045551234",
      businessType: "plumbing",
    };

    const result = await registerSchema.validateAsync(data);

    expect(result.userName).toBe(data.userName);
    expect(result.email).toBe(data.email);
    expect(result.businessName).toBe(data.businessName);
  });

  test("register fails without userName", async () => {
    const data = {
      email: "owner@callbackiq.com",
      password: "Password123",
      businessName: "Atlanta Pro Plumbing",
    };

    await expect(registerSchema.validateAsync(data)).rejects.toThrow();
  });

  test("register fails with invalid email", async () => {
    const data = {
      userName: "demoowner",
      email: "bad-email",
      password: "Password123",
      businessName: "Atlanta Pro Plumbing",
    };

    await expect(registerSchema.validateAsync(data)).rejects.toThrow();
  });

  test("valid login data passes", async () => {
    const data = {
      login: "demoowner",
      password: "Password123",
    };

    const result = await loginSchema.validateAsync(data);

    expect(result.login).toBe(data.login);
  });

  test("login fails without password", async () => {
    const data = {
      login: "demoowner",
    };

    await expect(loginSchema.validateAsync(data)).rejects.toThrow();
  });
});
