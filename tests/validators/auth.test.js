import { registerSchema, loginSchema } from "../../src/validator/auth.js";

const validRegisterData = {
  userName: "demoowner",
  email: "owner@callbackiq.com",
  password: "Password123",
  businessName: "Atlanta Pro Plumbing",
  businessPhone: "4045551234",
  businessType: "plumbing",
};

describe("Auth Validator", () => {
  describe("Register Schema", () => {
    test("valid owner registration data passes", async () => {
      const result = await registerSchema.validateAsync(validRegisterData);

      expect(result.userName).toBe("demoowner");
      expect(result.email).toBe("owner@callbackiq.com");
      expect(result.password).toBe("Password123");
      expect(result.businessName).toBe("Atlanta Pro Plumbing");
      expect(result.businessPhone).toBe("4045551234");
      expect(result.businessType).toBe("plumbing");
    });

    test("default role is owner", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      const result = await registerSchema.validateAsync(data);

      expect(result.role).toBe("owner");
    });

    test("default businessType is other", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      const result = await registerSchema.validateAsync(data);

      expect(result.businessType).toBe("other");
    });

    test("register fails without userName", async () => {
      const data = {
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with empty userName", async () => {
      const data = {
        userName: "",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails when userName is too short", async () => {
      const data = {
        userName: "ab",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails when userName is too long", async () => {
      const data = {
        userName: "a".repeat(31),
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with invalid email", async () => {
      const data = {
        userName: "demoowner",
        email: "bad-email",
        password: "Password123",
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
        password: "Password123",
        role: "supervisor",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails without businessName", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with empty businessName", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "",
        businessPhone: "4045551234",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails without businessPhone", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with empty businessPhone", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "",
      };

      await expect(registerSchema.validateAsync(data)).rejects.toThrow();
    });

    test("register fails with invalid businessType", async () => {
      const data = {
        userName: "demoowner",
        email: "owner@callbackiq.com",
        password: "Password123",
        businessName: "Atlanta Pro Plumbing",
        businessPhone: "4045551234",
        businessType: "restaurant",
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
        password: "Password123",
      };

      const result = await loginSchema.validateAsync(data);

      expect(result.login).toBe("demoowner");
      expect(result.password).toBe("Password123");
    });

    test("valid login with email passes", async () => {
      const data = {
        login: "owner@callbackiq.com",
        password: "Password123",
      };

      const result = await loginSchema.validateAsync(data);

      expect(result.login).toBe("owner@callbackiq.com");
    });

    test("login fails without login", async () => {
      const data = {
        password: "Password123",
      };

      await expect(loginSchema.validateAsync(data)).rejects.toThrow();
    });

    test("login fails without password", async () => {
      const data = {
        login: "demoowner",
      };

      await expect(loginSchema.validateAsync(data)).rejects.toThrow();
    });

    test("login fails with empty login", async () => {
      const data = {
        login: "",
        password: "Password123",
      };

      await expect(loginSchema.validateAsync(data)).rejects.toThrow();
    });

    test("login fails with empty password", async () => {
      const data = {
        login: "demoowner",
        password: "",
      };

      await expect(loginSchema.validateAsync(data)).rejects.toThrow();
    });

    test("extra unknown fields are rejected", async () => {
      const data = {
        login: "demoowner",
        password: "Password123",
        randomField: "bad",
      };

      await expect(
        loginSchema.validateAsync(data, { allowUnknown: false }),
      ).rejects.toThrow();
    });
  });
});
