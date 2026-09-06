import Db from "../db/db.js";
import User from "../models/user.js";
import Business from "../models/business.js";
import { verifyTurnstileToken } from "../helpers/security/turnstile.js";
import Token from "../helpers/jwt/token.js";
import bcrypt from "../helpers/bcrypt/bcrypt.js";
import crypto from "crypto";
import {
  registerSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "../validator/auth.js";
import * as validate from "../helpers/model/user.js";
import * as Response from "../helpers/response/response.js";
import { normalizePhoneToE164 as normalizeBusinessPhone } from "../voice/voicePhone.service.js";
import {
  createInactiveSubscription,
  getTrialEligibility,
} from "../helpers/billing/trial.js";
import {
  issueEmailVerification,
  securityGateEnabled,
} from "../services/trialIdentityVerification.service.js";
import { captureSignupSecurity } from "../services/trialRisk.service.js";

import sendPasswordResetEmail from "../helpers/email/mailer.js";
import { getTrustedRequestIp } from "../helpers/security/trustedRequestIp.js";

import mongoose from "mongoose";
import { runRegistrationTransaction } from "../services/registrationTransaction.service.js";
const isProduction = process.env.NODE_ENV === "production";
const shouldExposeAuthToken = !isProduction &&
  process.env.AUTH_RESPONSE_TOKEN_ENABLED !== "false";

const hashPasswordResetToken = (token) =>
  crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

const clearCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
};

const GENERIC_LOGIN_MESSAGE = "Invalid login or password";

const DUMMY_PASSWORD_HASH =
  process.env.DUMMY_PASSWORD_HASH ||
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

const SECURITY_DECAY_MS = 24 * 60 * 60 * 1000;

const getRetryAfterSeconds = (blockedUntil) => {
  if (!blockedUntil) {
    return 0;
  }

  return Math.max(
    0,
    Math.ceil((new Date(blockedUntil).getTime() - Date.now()) / 1000),
  );
};

const hasSecurityStateExpired = (lastFailedLoginAt) => {
  if (!lastFailedLoginAt) {
    return false;
  }

  return (
    Date.now() - new Date(lastFailedLoginAt).getTime() >= SECURITY_DECAY_MS
  );
};

const trialEligibilityMessage = (eligibility) => {
  if (eligibility?.eligible) {
    return "Account created successfully. Activate your 14-day trial to start CallBackIQ.";
  }
  if (eligibility?.reason === "disposable_email") {
    return "Account created successfully. This email domain is not eligible for a free trial, so choose a paid plan to activate CallBackIQ.";
  }
  return "Account created successfully. This customer or business identity has already used its lifetime free trial, so choose a paid plan to activate CallBackIQ.";
};

const getConsentIp = (req) => getTrustedRequestIp(req);


const buildAuthToken = (user, fallbackSessionVersion = 0) =>
  Token.sign({
    userId: user._id,
    userName: user.userName,
    email: user.email,
    role: user.role,
    sessionVersion: Number(
      user.sessionVersion ?? fallbackSessionVersion ?? 0,
    ),
  });

class AuthController {
  static async register(req, res) {
    const {
      userName,
      email,
      password,
      role = "owner",
      businessName,
      businessPhone,
      forwardingPhone,
      businessType = "other",
      smsConsent,
      termsAccepted,
      privacyAccepted,
    } = req.body;

    try {
      await registerSchema.validateAsync(req.body);

      if (securityGateEnabled("REGISTER_TURNSTILE_REQUIRED")) {
        const challenge = await verifyTurnstileToken(
          req.body?.securityChallengeToken || "",
          req,
          { expectedAction: "register" },
        );
        if (!challenge.success) {
          return res.status(403).json({
            success: false,
            code: "REGISTRATION_SECURITY_CHALLENGE_REQUIRED",
            message: "Complete the security check before creating your account.",
          });
        }
      }

      const normalizedEmail = String(email || "")
        .trim()
        .toLowerCase();
      const normalizedUserName =
        String(userName || "").trim() ||
        `cbq${crypto
          .createHash("sha256")
          .update(normalizedEmail)
          .digest("hex")
          .slice(0, 20)}`;

      if (!validate.isValidPassword(password)) {
        return Response.responseInvalidInput(res, "Invalid password format");
      }

      /*
       * Legal acceptance (Terms of Service + Privacy Policy) is required to
       * create an account. This is separate from SMS consent below.
       */
      if (!termsAccepted || !privacyAccepted) {
        return Response.responseInvalidInput(
          res,
          "You must accept the Terms of Service and Privacy Policy",
        );
      }

      const existingUser = await Db.findUserByEmailOrUserName(
        User,
        normalizedUserName,
        normalizedEmail,
      );

      if (existingUser) {
        return Response.responseConflict(
          res,
          "User with this username or email already exists",
        );
      }

      // Older registration clients may still send the owner's existing
      // routing number. The new trial flow collects it during onboarding. It is
      // never the CallBackIQ/Twilio tracking number; tracking-number assignment
      // remains a post-subscription lifecycle.
      const normalizedForwardingPhone = String(
        forwardingPhone || businessPhone || "",
      ).trim();
      const normalizedForwardingLookup =
        normalizeBusinessPhone(normalizedForwardingPhone) ||
        normalizedForwardingPhone;
      if (normalizedForwardingPhone) {
        const existingForwardingPhone = await Business.exists({
          forwardingPhone: {
            $in: [normalizedForwardingPhone, normalizedForwardingLookup],
          },
        });
        if (existingForwardingPhone) {
          return Response.responseConflict(
            res,
            "This forwarding phone is already registered",
          );
        }
      }


      const hashedPassword = await bcrypt.hashPassword(password, 10);

      const now = new Date();

      /*
       * SMS consent is optional and never blocks account creation. Only
       * record consent metadata (timestamp/IP/user agent) when the user
       * actually opted in, so we don't imply consent that wasn't given.
       */
      const smsConsentGiven = Boolean(smsConsent);

      // CALLBACKIQ_REGISTRATION_TRANSACTION_V1
      // CALLBACKIQ_REGISTRATION_TRANSACTION_V1_1
      let savedUser;
      let savedBusiness;
      let savedSubscription;
      let trialEligibility;
      let emailVerificationSent = false;

      const persistRegistration = async (registrationSession = null) => {

      savedUser = await Db.saveUser(User, {
        userName: normalizedUserName,
        email: normalizedEmail,
        password: hashedPassword,
        role: "owner",
        businessName,
        // User.businessPhone is retained for compatibility with existing
        // profile/session code, but represents the existing business line.
        businessPhone: normalizedForwardingPhone,
        businessType,

        smsConsent: smsConsentGiven,
        smsConsentAt: smsConsentGiven ? now : null,
        smsConsentIp: smsConsentGiven ? getConsentIp(req) : "",
        smsConsentUserAgent: smsConsentGiven
          ? req.headers["user-agent"] || ""
          : "",

        termsAccepted: true,
        termsAcceptedAt: now,
        privacyAccepted: true,
        privacyAcceptedAt: now,
      }, { session: registrationSession });

      savedBusiness = await Db.saveBusiness(Business, {
        owner: savedUser._id,
        businessName,
        businessType,
        forwardingPhone: normalizedForwardingPhone,
        email: normalizedEmail,
        isActive: true,
        trackingNumber: {
          provider: "twilio",
          status: "unassigned",
        },
        setupProgress: {
          accountRegistered: true,
          forwardingPhoneConfigured: Boolean(normalizedForwardingPhone),
          updatedAt: now,
        },
        signupSecurity: captureSignupSecurity(req, businessName),
      }, { session: registrationSession });

      /*
       * Registration never consumes the lifetime trial and never provisions a
       * telecom resource. It creates the account, checks eligibility, and
       * waits for signed Stripe completion before access becomes active.
       */
      // Keep Business.isActive true: it represents account suspension, not
      // subscription entitlement. Subscription middleware owns product access.
      savedBusiness.setupProgress.subscriptionActivated = false;
      savedBusiness.setupProgress.updatedAt = new Date();
      await savedBusiness.save({ session: registrationSession });

      savedSubscription = await createInactiveSubscription(savedBusiness._id, { session: registrationSession });
      trialEligibility = await getTrialEligibility({
        business: savedBusiness,
        ownerId: savedUser._id,
        subscription: savedSubscription,
        session: registrationSession,
      });

      };
      await runRegistrationTransaction(persistRegistration);
if (securityGateEnabled("TRIAL_REQUIRE_EMAIL_VERIFICATION")) {
        try {
          const verification = await issueEmailVerification({ user: savedUser });
          emailVerificationSent = verification?.sent === true;
        } catch (verificationError) {
          console.error("Unable to send signup email verification:", {
            code: verificationError?.code,
            message: verificationError?.message,
          });
        }
      }
    

      const token = buildAuthToken(savedUser);

      res.cookie("token", token, cookieOptions);

      return Response.responseCreated(
        res,
        {
          ...(shouldExposeAuthToken ? { token } : {}),
          user: {
            _id: savedUser._id,
            userName: savedUser.userName,
            email: savedUser.email,
            role: savedUser.role,
            businessName: savedUser.businessName,
            businessPhone: savedUser.businessPhone,
            businessType: savedUser.businessType,
            smsConsent: savedUser.smsConsent,
            smsConsentAt: savedUser.smsConsentAt,
            termsAccepted: savedUser.termsAccepted,
            termsAcceptedAt: savedUser.termsAcceptedAt,
            privacyAccepted: savedUser.privacyAccepted,
            privacyAcceptedAt: savedUser.privacyAcceptedAt,
          },
          business: savedBusiness,
          subscription: savedSubscription,
          trialGranted: false,
          trialEligible: trialEligibility.eligible,
          trialActivationRequired: trialEligibility.eligible,
          trialDeniedReason: trialEligibility.reason || null,
          emailVerificationRequired: securityGateEnabled(
            "TRIAL_REQUIRE_EMAIL_VERIFICATION",
          ),
          emailVerificationSent,
        },
        trialEligibilityMessage(trialEligibility),
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      if (error.code === 11000) {
        return Response.responseConflict(
          res,
          "Username, email, or business already exists",
        );
      }

      console.error("Register error:", error);
      return Response.responseServerError(res);
    }
  }

  static async login(req, res) {
    const { login, password, securityChallengeToken = "" } = req.body;

    try {
      await loginSchema.validateAsync(req.body);

      const normalizedLogin = login.trim();
      let user = await Db.findUserByLogin(User, normalizedLogin);

      /*
       * Always perform a password-hash comparison, even when the account does
       * not exist. This reduces the obvious timing difference between existing
       * and nonexistent accounts.
       */
      const passwordHash = user?.password || DUMMY_PASSWORD_HASH;
      const isMatch = await bcrypt.comparePassword(password, passwordHash);

      if (!user) {
        return Response.responseBadAuth(res, GENERIC_LOGIN_MESSAGE);
      }

      /*
       * Reset old security escalation after 24 hours without another failure.
       */
      if (hasSecurityStateExpired(user.lastFailedLoginAt)) {
        await Db.decayLoginSecurityState(User, user._id);

        user.failedLoginAttempts = 0;
        user.lastFailedLoginAt = null;
        user.loginBlockedUntil = null;
        user.loginLockoutLevel = 0;
        user.lastLoginLockoutAt = null;
        user.securityChallengeRequired = false;
        user.securityChallengeRequiredAt = null;
      }

      const retryAfterSeconds = getRetryAfterSeconds(user.loginBlockedUntil);

      /*
       * Do not return an account-specific lock message. A generic 401 prevents
       * the blocked state from becoming an easy account-enumeration signal.
       *
       * IP-level abuse is handled separately by loginRateLimit with HTTP 429.
       */
      if (retryAfterSeconds > 0) {
        return Response.responseBadAuth(res, GENERIC_LOGIN_MESSAGE);
      }

      if (!isMatch) {
        await Db.recordFailedLogin(User, user._id);

        return Response.responseBadAuth(res, GENERIC_LOGIN_MESSAGE);
      }

      /*
       * CAPTCHA is checked only after the password is correct. This prevents
       * the CAPTCHA-required response from revealing that an account exists.
       */
      if (user.securityChallengeRequired) {
        const challengeResult = await verifyTurnstileToken(
          securityChallengeToken,
          req,
        );

        if (!challengeResult.success) {
          return res.status(403).json({
            success: false,
            message:
              "Additional verification is required before you can sign in.",
            code: "SECURITY_CHALLENGE_REQUIRED",
            actionRequired: {
              type: "captcha",
              passwordResetAvailable: true,
            },
          });
        }
      }

      /*
       * Clear failure counts, temporary delays, escalation, and CAPTCHA state
       * after a successful password and challenge verification.
       */
      const authenticatedUser =
        (await Db.clearLoginSecurityState(User, user._id)) || user;

      const token = buildAuthToken(authenticatedUser, user.sessionVersion);

      res.cookie("token", token, cookieOptions);

      return Response.responseOk(
        res,
        {
          ...(shouldExposeAuthToken ? { token } : {}),
          user: {
            _id: authenticatedUser._id,
            userName: authenticatedUser.userName,
            email: authenticatedUser.email,
            role: authenticatedUser.role,
            businessName: authenticatedUser.businessName,
            businessPhone: authenticatedUser.businessPhone,
            businessType: authenticatedUser.businessType,
            smsConsent: authenticatedUser.smsConsent,
            smsConsentAt: authenticatedUser.smsConsentAt,
            termsAccepted: authenticatedUser.termsAccepted,
            termsAcceptedAt: authenticatedUser.termsAcceptedAt,
            privacyAccepted: authenticatedUser.privacyAccepted,
            privacyAcceptedAt: authenticatedUser.privacyAcceptedAt,
            lastSuccessfulLoginAt:
              authenticatedUser.lastSuccessfulLoginAt || new Date(),
          },
        },
        "Login successful",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Login error:", error);
      return Response.responseServerError(res);
    }
  }

  static async me(req, res) {
    try {
      const userId = req.user?.userId;

      if (!userId) {
        return Response.responseBadAuth(res, "Not logged in");
      }

      const user = await Db.getUserById(User, userId);

      if (!user) {
        return Response.responseBadAuth(res, "User not found");
      }

      return Response.responseOk(res, user, "Current user fetched");
    } catch (error) {
      console.error("Me error:", error);
      return Response.responseServerError(res);
    }
  }

  static async requestPasswordReset(req, res) {
    try {
      await requestPasswordResetSchema.validateAsync(req.body);

      const { email } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      const user = await Db.findUserByEmail(User, normalizedEmail);

      if (!user) {
        return Response.responseOk(
          res,
          null,
          "If an account exists with that email, a password reset link has been sent",
        );
      }

      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const resetTokenHash = hashPasswordResetToken(resetToken);

      await Db.savePasswordResetToken(
        User,
        user._id,
        resetTokenHash,
        resetTokenExpiresAt,
      );

      try {
        await sendPasswordResetEmail(user.email, resetToken);
      } catch (emailError) {
        console.error("Password reset email error:", emailError);
        return Response.responseServerError(
          res,
          "Unable to send password reset email",
        );
      }

      return Response.responseOk(
        res,
        null,
        "If an account exists with that email, a password reset link has been sent",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Request password reset error:", error);
      return Response.responseServerError(res);
    }
  }

  static async resetPassword(req, res) {
    try {
      await resetPasswordSchema.validateAsync(req.body);

      const { resetToken } = req.params;
      const { password } = req.body;

      if (!resetToken) {
        return Response.responseInvalidInput(res, "Reset token is required");
      }

      if (!validate.isValidPassword(password)) {
        return Response.responseInvalidInput(res, "Invalid password format");
      }

      const resetTokenHash = hashPasswordResetToken(resetToken);
      const user = await Db.findUserByPasswordResetToken(User, resetTokenHash);

      if (!user) {
        return Response.responseInvalidInput(
          res,
          "Invalid or expired reset token",
        );
      }

      const hashedPassword = await bcrypt.hashPassword(password, 10);

      await Db.saveResetPassword(User, user._id, hashedPassword);

      return Response.responseOk(res, null, "Password reset successfully");
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Reset password error:", error);
      return Response.responseServerError(res);
    }
  }

  static async logout(req, res) {
    try {
      res.clearCookie("token", clearCookieOptions);

      return res.status(200).json({
        success: true,
        message: "Logout successful",
      });
    } catch (error) {
      console.error("Logout error:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AuthController;
