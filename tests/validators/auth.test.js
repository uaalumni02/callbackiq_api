import { registerSchema, loginSchema } from "../../src/validator/auth.js";

const validRegisterData = {
  userName: "demoowner",
  email: "owner@callbackiq.com",
  password: "LongFixturePassword123",
  businessName: "Atlanta Pro Plumbing",
  businessPhone: "4045551234",
  businessType: "plumbing",
  smsConsent: true,
  termsAccepted: true,
  privacyAccepted: true,
};

describe("Auth Validator", () => {
  describe("Register Schema", () => {
    test("valid owner registration data passes", async () => {
      const result = await registerSchema.validateAsync(validRegisterData);

      expect(result.userName).toBe("demoowner");
      expect(result.email).toBe("owner@callbackiq.com");
      expect(result.password).toBe("LongFixturePassword123");
      expect(result.businessName).toBe("Atlanta Pro Plumbing");
      expect(result.businessPhone).toBe("4045551234");
      expect(result.businessType).toBe("plumbing");
    });

    test("default role is owner", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      };

      const result = await registerSchema.validateAsync(data);

      expect(result.role).toBe("owner");
    });

    test("default businessType is other", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      };

      const result = await registerSchema.validateAsync(data);

      expect(result.businessType).toBe("other");
    });

    test("register allows userName to be omitted for trial signup", async () => {
      const data = {
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        termsAccepted: true,
        privacyAccepted: true,
      };

      const result = await registerSchema.validateAsync(data);

      expect(result.userName).toBeUndefined();
      expect(result.businessPhone).toBeUndefined();
      expect(result.forwardingPhone).toBeUndefined();
      expect(result.businessType).toBe("other");
    });

    test("register fails with empty userName", async () => {
      const data = {
        userName: "",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails when userName is too short", async () => {
      const data = {
        userName: "ab",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails when userName is too long", async () => {
      const data = {
        userName: "a".repeat(31),
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with invalid email", async () => {
      const data = {
        userName: "demoowner",
        email: "bad-email",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails without password", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails when password is too short", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "12345",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails when password is too long", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "a".repeat(51),
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with invalid role", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        role: "supervisor",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails without businessName", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with empty businessName", async () => {
      const data = {
        userName: "",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register allows forwarding phone to be omitted until setup", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        termsAccepted: true,
        privacyAccepted: true,
      };

      const result = await registerSchema.validateAsync(data);

      expect(result.businessPhone).toBeUndefined();
      expect(result.forwardingPhone).toBeUndefined();
    });

    test("register fails with empty businessPhone", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register accepts a supported restaurant businessType", async () => {
      const result = await registerSchema.validateAsync({
        ...validRegisterData,
        businessType: "restaurant",
      });
      expect(result.businessType).toBe("restaurant");
    });

    test("register rejects an unsupported businessType", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "LongFixturePassword123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
        businessType: "unsupported_industry",
        smsConsent: true,
        termsAccepted: true,
        privacyAccepted: true,
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("extra unknown fields are rejected", async () => {
      const data = {
        ...validRegisterData,
        randomField: "bad",
      };

      await expect(
        registerSchema.validateAsync(data, { allowUnknown: false }),
      ).rejects.toThrow();
    });
  });

  describe("Login Schema", () => {
    test("valid login with username passes", async () => {
      const data = {
        login: "demoowner",
        password: "LongFixturePassword123",
      };

      const result = await loginSchema.validateAsync(data);

      expect(result.login).toBe("demoowner");
      expect(result.password).toBe("LongFixturePassword123");
    });

    test("valid login with email passes", async () => {
      const data = {
        login: "owner@callbackiq.com",
        password: "LongFixturePassword123",
      };

      const result = await loginSchema.validateAsync(data);

      expect(result.login).toBe("owner@callbackiq.com");
    });

    test("login fails without login", async () => {
      await expect(
        loginSchema.validateAsync({
          password: "LongFixturePassword123",
        }),
      ).rejects.toThrow();
    });

    test("login fails without password", async () => {
      await expect(
        loginSchema.validateAsync({
          login: "demoowner",
        }),
      ).rejects.toThrow();
    });

    test("login fails with empty login", async () => {
      await expect(
        loginSchema.validateAsync({
          login: "",
          password: "LongFixturePassword123",
        }),
      ).rejects.toThrow();
    });

    test("login fails with empty password", async () => {
      await expect(
        loginSchema.validateAsync({
          login: "demoowner",
          password: "",
        }),
      ).rejects.toThrow();
    });

    test("extra unknown fields are rejected", async () => {
      await expect(
        loginSchema.validateAsync(
          {
            login: "demoowner",
            password: "LongFixturePassword123",
            randomField: "bad",
          },
          { allowUnknown: false },
        ),
      ).rejects.toThrow();
    });
  });
});
