import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";
import sendPasswordResetEmail from "../../src/helpers/email/mailer.js";

jest.mock("../../src/helpers/email/mailer.js", () => {
  const actual = jest.requireActual("../../src/helpers/email/mailer.js");

  return {
    ...actual,
    __esModule: true,
    default: jest.fn().mockResolvedValue({
      accepted: ["owner@callbackiq.com"],
      messageId: "test-password-reset-email",
    }),
  };
});

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const validRegisterPayload = {
  userName: "demoowner",
  email: "owner@callbackiq.com",
  password: "Password123",
  businessName: "Atlanta Pro Plumbing",
  businessPhone: "4045551234",
  businessType: "plumbing",

  smsConsent: true,
  termsAccepted: true,
  privacyAccepted: true,
};

const loginSecurityFields = [
  "+failedLoginAttempts",
  "+lastFailedLoginAt",
  "+loginBlockedUntil",
  "+loginLockoutLevel",
  "+lastLoginLockoutAt",
  "+securityChallengeRequired",
  "+securityChallengeRequiredAt",
].join(" ");

const getUserWithLoginSecurity = async (email = validRegisterPayload.email) => {
  return User.findOne({ email }).select(loginSecurityFields);
};

describe("Auth Routes", () => {
  test("POST /api/auth/register creates an enabled account with inactive subscription entitlement", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(validRegisterPayload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.email).toBe("owner@callbackiq.com");
    expect(res.body.data.business.businessName).toBe("Atlanta Pro Plumbing");
    expect(res.body.data.business.phone).toBeUndefined();
    expect(res.body.data.business.forwardingPhone).toBe("+14045551234");
    expect(res.body.data.business.trackingNumber.status).toBe("unassigned");
    expect(res.body.data.subscription.status).toBe("none");
    expect(res.body.data.trialEligible).toBe(true);
    expect(res.body.data.trialGranted).toBe(false);

    const savedUser = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+password");

    expect(savedUser).toBeTruthy();
    expect(savedUser.password).toBeTruthy();
    expect(savedUser.password).not.toBe("Password123");

    const savedBusiness = await Business.findOne({
      owner: savedUser._id,
    });

    expect(savedBusiness).toBeTruthy();
    expect(savedBusiness.businessName).toBe("Atlanta Pro Plumbing");
    // Registration does not persist the customer-entered forwarding number
    // as the CallBackIQ/Twilio tracking number.
    expect(savedBusiness.phone).toBeUndefined();
    // Business.isActive is the administrative account switch. Subscription
    // status/aiEnabled control product entitlement after registration.
    expect(savedBusiness.isActive).toBe(true);

    const savedSubscription = await Subscription.findOne({
      business: savedBusiness._id,
    });

    expect(savedSubscription).toBeTruthy();
    expect(savedSubscription.plan).toBe("pro");
    expect(savedSubscription.status).toBe("none");
    expect(savedSubscription.aiEnabled).toBe(false);
    expect(savedSubscription.trialUsedAt).toBeFalsy();
    expect(savedSubscription.trialCount).toBe(0);
  });

  test("POST /api/auth/register rejects duplicate user", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app)
      .post("/api/auth/register")
      .send({
        ...validRegisterPayload,
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/auth/register rejects invalid data", async () => {
    const res = await request(app).post("/api/auth/register").send({
      userName: "",
      email: "bad-email",
      password: "123",
      businessName: "",
      businessPhone: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/auth/login logs user in with username", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/auth/login").send({
      login: "demoowner",
      password: "Password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.userName).toBe("demoowner");
  });

  test("POST /api/auth/login logs user in with email", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/auth/login").send({
      login: "owner@callbackiq.com",
      password: "Password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
  });

  test("POST /api/auth/login rejects bad password with generic response", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/auth/login").send({
      login: "demoowner",
      password: "WrongPassword",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid login or password");

    const serializedResponse = JSON.stringify(res.body).toLowerCase();

    expect(serializedResponse).not.toContain("remainingattempts");
    expect(serializedResponse).not.toContain("user exists");
    expect(serializedResponse).not.toContain("email exists");
    expect(serializedResponse).not.toContain("incorrect password");
  });

  test("POST /api/auth/login returns the same generic response for an unknown account", async () => {
    const res = await request(app).post("/api/auth/login").send({
      login: "missing-user@callbackiq.com",
      password: "WrongPassword",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid login or password");

    const missingUser = await User.findOne({
      email: "missing-user@callbackiq.com",
    });

    expect(missingUser).toBeNull();
  });

  test("POST /api/auth/login increments failed login attempts inside the observation window", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({
          login: validRegisterPayload.email,
          password: `WrongPassword${attempt}`,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid login or password");

      const user = await getUserWithLoginSecurity();

      expect(user).toBeTruthy();
      expect(user.failedLoginAttempts).toBe(attempt);
      expect(user.loginLockoutLevel).toBe(0);
      expect(user.loginBlockedUntil).toBeNull();
      expect(user.securityChallengeRequired).toBe(false);
      expect(user.lastFailedLoginAt).toBeTruthy();
    }
  });

  test("POST /api/auth/login applies the first temporary delay on the fifth failed attempt", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const beforeFailures = Date.now();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({
          login: validRegisterPayload.email,
          password: `WrongPassword${attempt}`,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid login or password");
    }

    const user = await getUserWithLoginSecurity();

    expect(user).toBeTruthy();
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.loginLockoutLevel).toBe(1);
    expect(user.loginBlockedUntil).toBeTruthy();
    expect(user.lastLoginLockoutAt).toBeTruthy();
    expect(user.securityChallengeRequired).toBe(false);

    expect(user.loginBlockedUntil.getTime()).toBeGreaterThan(beforeFailures);

    expect(user.loginBlockedUntil.getTime()).toBeGreaterThan(Date.now());

    /*
     * The first delay should be approximately one minute.
     * This allows a small margin for test execution time.
     */
    const delayMilliseconds =
      user.loginBlockedUntil.getTime() - user.lastLoginLockoutAt.getTime();

    expect(delayMilliseconds).toBeGreaterThanOrEqual(59 * 1000);
    expect(delayMilliseconds).toBeLessThanOrEqual(61 * 1000);
  });

  test("POST /api/auth/login rejects a correct password while the temporary delay is active", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    await User.findOneAndUpdate(
      { email: validRegisterPayload.email },
      {
        failedLoginAttempts: 0,
        loginLockoutLevel: 1,
        loginBlockedUntil: new Date(Date.now() + 60 * 1000),
        lastFailedLoginAt: new Date(),
        lastLoginLockoutAt: new Date(),
      },
      {
        returnDocument: "after",
      },
    );

    const res = await request(app).post("/api/auth/login").send({
      login: validRegisterPayload.email,
      password: validRegisterPayload.password,
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid login or password");

    const user = await getUserWithLoginSecurity();

    expect(user.loginBlockedUntil).toBeTruthy();
    expect(user.loginBlockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  test("POST /api/auth/login clears short-term security state after successful login", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failedRes = await request(app)
        .post("/api/auth/login")
        .send({
          login: validRegisterPayload.email,
          password: `WrongPassword${attempt}`,
        });

      expect(failedRes.status).toBe(401);
    }

    const userBeforeLogin = await getUserWithLoginSecurity();

    expect(userBeforeLogin.failedLoginAttempts).toBe(3);
    expect(userBeforeLogin.lastFailedLoginAt).toBeTruthy();

    const successfulRes = await request(app).post("/api/auth/login").send({
      login: validRegisterPayload.email,
      password: validRegisterPayload.password,
    });

    expect(successfulRes.status).toBe(200);
    expect(successfulRes.body.success).toBe(true);
    expect(successfulRes.body.data.token).toBeTruthy();

    const userAfterLogin = await getUserWithLoginSecurity();

    expect(userAfterLogin.failedLoginAttempts).toBe(0);
    expect(userAfterLogin.lastFailedLoginAt).toBeNull();
    expect(userAfterLogin.loginBlockedUntil).toBeNull();
    expect(userAfterLogin.loginLockoutLevel).toBe(0);
    expect(userAfterLogin.lastLoginLockoutAt).toBeNull();
    expect(userAfterLogin.securityChallengeRequired).toBe(false);
    expect(userAfterLogin.securityChallengeRequiredAt).toBeNull();
    expect(userAfterLogin.lastSuccessfulLoginAt).toBeTruthy();
  });

  test("POST /api/auth/login decays security state after 24 hours without another failure", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const olderThanTwentyFourHours = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await User.findOneAndUpdate(
      { email: validRegisterPayload.email },
      {
        failedLoginAttempts: 4,
        lastFailedLoginAt: olderThanTwentyFourHours,
        loginBlockedUntil: null,
        loginLockoutLevel: 3,
        lastLoginLockoutAt: olderThanTwentyFourHours,
        securityChallengeRequired: true,
        securityChallengeRequiredAt: olderThanTwentyFourHours,
      },
      {
        returnDocument: "after",
      },
    );

    /*
     * The old state should decay first. The current failed request should
     * then begin a new observation window with one failed attempt.
     */
    const res = await request(app).post("/api/auth/login").send({
      login: validRegisterPayload.email,
      password: "WrongPasswordAfterDecay",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid login or password");

    const user = await getUserWithLoginSecurity();

    expect(user.failedLoginAttempts).toBe(1);
    expect(user.loginLockoutLevel).toBe(0);
    expect(user.loginBlockedUntil).toBeNull();
    expect(user.lastLoginLockoutAt).toBeNull();
    expect(user.securityChallengeRequired).toBe(false);
    expect(user.securityChallengeRequiredAt).toBeNull();
    expect(user.lastFailedLoginAt).toBeTruthy();
    expect(user.lastFailedLoginAt.getTime()).toBeGreaterThan(
      olderThanTwentyFourHours.getTime(),
    );
  });

  test("POST /api/password-reset creates reset token for existing user", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const res = await request(app).post("/api/password-reset").send({
      email: "owner@callbackiq.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const savedUser = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    expect(savedUser).toBeTruthy();
    expect(savedUser.resetToken).toBeTruthy();
    expect(savedUser.resetTokenExpiresAt).toBeTruthy();
    expect(savedUser.resetTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("POST /api/password-reset returns success for unknown email without creating token", async () => {
    const res = await request(app).post("/api/password-reset").send({
      email: "missing@callbackiq.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const missingUser = await User.findOne({
      email: "missing@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    expect(missingUser).toBeNull();
  });

  test("POST /api/password-reset rejects invalid email", async () => {
    const res = await request(app).post("/api/password-reset").send({
      email: "bad-email",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/password-reset/:resetToken resets password, clears token, and clears login security state", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    await User.findOneAndUpdate(
      { email: validRegisterPayload.email },
      {
        failedLoginAttempts: 4,
        lastFailedLoginAt: new Date(),
        loginBlockedUntil: new Date(Date.now() + 30 * 60 * 1000),
        loginLockoutLevel: 3,
        lastLoginLockoutAt: new Date(),
        securityChallengeRequired: true,
        securityChallengeRequiredAt: new Date(),
      },
      {
        returnDocument: "after",
      },
    );

    sendPasswordResetEmail.mockClear();

    await request(app).post("/api/password-reset").send({
      email: "owner@callbackiq.com",
    });

    const resetEmailCall = sendPasswordResetEmail.mock.calls.at(-1);
    expect(resetEmailCall).toBeTruthy();

    const plaintextResetToken = resetEmailCall[1];
    expect(plaintextResetToken).toEqual(expect.any(String));

    const userWithToken = await User.findOne({
      email: "owner@callbackiq.com",
    }).select(
      ["+resetToken", "+resetTokenExpiresAt", loginSecurityFields].join(" "),
    );

    expect(userWithToken.resetToken).toBeTruthy();

    // Production stores only the SHA-256 hash. The plaintext token exists
    // only in the password-reset email.
    expect(userWithToken.resetToken).not.toBe(plaintextResetToken);

    const resetRes = await request(app)
      .post(`/api/password-reset/${plaintextResetToken}`)
      .send({
        password: "NewPassword123",
      });

    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    const updatedUser = await User.findOne({
      email: "owner@callbackiq.com",
    }).select(
      [
        "+password",
        "+resetToken",
        "+resetTokenExpiresAt",
        loginSecurityFields,
      ].join(" "),
    );

    expect(updatedUser.resetToken).toBeNull();
    expect(updatedUser.resetTokenExpiresAt).toBeNull();
    expect(updatedUser.password).toBeTruthy();
    expect(updatedUser.password).not.toBe("NewPassword123");

    expect(updatedUser.failedLoginAttempts).toBe(0);
    expect(updatedUser.lastFailedLoginAt).toBeNull();
    expect(updatedUser.loginBlockedUntil).toBeNull();
    expect(updatedUser.loginLockoutLevel).toBe(0);
    expect(updatedUser.lastLoginLockoutAt).toBeNull();
    expect(updatedUser.securityChallengeRequired).toBe(false);
    expect(updatedUser.securityChallengeRequiredAt).toBeNull();

    const oldLoginRes = await request(app).post("/api/auth/login").send({
      login: "owner@callbackiq.com",
      password: "Password123",
    });

    expect(oldLoginRes.status).toBe(401);
    expect(oldLoginRes.body.success).toBe(false);
    expect(oldLoginRes.body.message).toBe("Invalid login or password");

    const newLoginRes = await request(app).post("/api/auth/login").send({
      login: "owner@callbackiq.com",
      password: "NewPassword123",
    });

    expect(newLoginRes.status).toBe(200);
    expect(newLoginRes.body.success).toBe(true);
    expect(newLoginRes.body.data.token).toBeTruthy();
  });

  test("POST /api/password-reset/:resetToken rejects invalid token", async () => {
    const res = await request(app).post("/api/password-reset/bad-token").send({
      password: "NewPassword123",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/password-reset/:resetToken rejects expired token", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    const expiredToken = "expired-reset-token";

    await User.findOneAndUpdate(
      { email: "owner@callbackiq.com" },
      {
        resetToken: expiredToken,
        resetTokenExpiresAt: new Date(Date.now() - 60 * 1000),
      },
      {
        returnDocument: "after",
      },
    );

    const res = await request(app)
      .post(`/api/password-reset/${expiredToken}`)
      .send({
        password: "NewPassword123",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/password-reset/:resetToken rejects invalid password format", async () => {
    await request(app).post("/api/auth/register").send(validRegisterPayload);

    await request(app).post("/api/password-reset").send({
      email: "owner@callbackiq.com",
    });

    const userWithToken = await User.findOne({
      email: "owner@callbackiq.com",
    }).select("+resetToken +resetTokenExpiresAt");

    const res = await request(app)
      .post(`/api/password-reset/${userWithToken.resetToken}`)
      .send({
        password: "123",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/auth/me rejects unauthenticated request", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/auth/me returns current user when authenticated", async () => {
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send(validRegisterPayload);

    const token = registerRes.body.data.token;

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe("owner@callbackiq.com");
  });

  test("POST /api/auth/logout clears session", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  /*
   * Keep this test last because the default express-rate-limit memory store
   * persists for the lifetime of the imported app. Database cleanup does not
   * clear the rate limiter's in-memory request counters.
   */
  test("POST /api/auth/login rate limits excessive requests from the same IP and returns Retry-After", async () => {
    let rateLimitedResponse = null;

    /*
     * Use a nonexistent identifier so this test exercises the IP limiter
     * without changing account-level login security fields.
     *
     * The loop stops as soon as the limiter returns 429. The maximum allows
     * for different configured thresholds and failed requests made earlier
     * in this test suite.
     */
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({
          login: "rate-limit-test@callbackiq.com",
          password: `WrongPassword${attempt}`,
        });

      if (res.status === 429) {
        rateLimitedResponse = res;
        break;
      }

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid login or password");
    }

    expect(rateLimitedResponse).toBeTruthy();
    expect(rateLimitedResponse.status).toBe(429);
    expect(rateLimitedResponse.body.success).toBe(false);
    expect(rateLimitedResponse.body.message).toBe(
      "Too many login attempts. Please try again later.",
    );

    const retryAfterHeader = rateLimitedResponse.headers["retry-after"];

    expect(retryAfterHeader).toBeTruthy();
    expect(Number(retryAfterHeader)).toBeGreaterThan(0);
  });
});
