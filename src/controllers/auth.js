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
import {
  grantFreeTrial,
  createInactiveSubscription,
} from "../helpers/billing/trial.js";

import sendPasswordResetEmail from "../helpers/email/mailer.js";

const isProduction = process.env.NODE_ENV === "production";

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

const trialGrantedMessage = (granted) => {
  return granted
    ? "Account created successfully"
    : "Account created successfully. This business has already used its free trial, so choose a plan to activate CallBackIQ.";
};

class AuthController {
  static async register(req, res) {
    const {
      userName,
      email,
      password,
      role = "owner",
      businessName,
      businessPhone,
      businessType = "other",
      smsConsent,
      termsAccepted,
      privacyAccepted,
    } = req.body;

    try {
      await registerSchema.validateAsync(req.body);

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
        userName,
        email,
      );

      if (existingUser) {
        return Response.responseConflict(
          res,
          "User with this username or email already exists",
        );
      }

      const hashedPassword = await bcrypt.hashPassword(password, 10);

      const now = new Date();

      /*
       * SMS consent is optional and never blocks account creation. Only
       * record consent metadata (timestamp/IP/user agent) when the user
       * actually opted in, so we don't imply consent that wasn't given.
       */
      const smsConsentGiven = Boolean(smsConsent);

      const savedUser = await Db.saveUser(User, {
        userName,
        email,
        password: hashedPassword,
        role,
        businessName,
        businessPhone,
        businessType,

        smsConsent: smsConsentGiven,
        smsConsentAt: smsConsentGiven ? now : null,
        smsConsentIp: smsConsentGiven
          ? req.ip || req.headers["x-forwarded-for"] || ""
          : "",
        smsConsentUserAgent: smsConsentGiven
          ? req.headers["user-agent"] || ""
          : "",

        termsAccepted: true,
        termsAcceptedAt: now,
        privacyAccepted: true,
        privacyAcceptedAt: now,
      });

      const savedBusiness = await Db.saveBusiness(Business, {
        owner: savedUser._id,
        businessName,
        businessType,
        phone: businessPhone,
        email,
        isActive: true,
      });

      /*
       * The signup trial goes through the same helper as the billing
       * endpoint. Creating it inline here previously skipped the trialUsedAt
       * stamp and the redemption record, so an expired signup trial still
       * looked unused and a second trial could be claimed afterward.
       */
      const trialResult = await grantFreeTrial({
        business: savedBusiness,
        ownerId: savedUser._id,
        grantedBy: "self",
      });

      let savedSubscription = trialResult.subscription;

      /*
       * A denied trial means this identity has already used one, typically a
       * repeat signup on the same business phone or email. That is not a
       * reason to block the account â€” it just starts without free access.
       */
      if (!trialResult.granted) {
        savedSubscription = await createInactiveSubscription(savedBusiness._id);

        savedBusiness.isActive = false;
        await savedBusiness.save();
      }

      const token = Token.sign({
        userId: savedUser._id,
        userName: savedUser.userName,
        email: savedUser.email,
        role: savedUser.role,
      });

      res.cookie("token", token, cookieOptions);

      return Response.responseCreated(
        res,
        {
          token,
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
          trialGranted: trialResult.granted,
        },
        trialGrantedMessage(trialResult.granted),
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
        user = await Db.findUserByLogin(User, normalizedLogin);
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
      await Db.clearLoginSecurityState(User, user._id);

      const token = Token.sign({
        userId: user._id,
        userName: user.userName,
        email: user.email,
        role: user.role,
      });

      res.cookie("token", token, cookieOptions);

      return Response.responseOk(
        res,
        {
          token,
          user: {
            _id: user._id,
            userName: user.userName,
            email: user.email,
            role: user.role,
            businessName: user.businessName,
            businessPhone: user.businessPhone,
            businessType: user.businessType,
            smsConsent: user.smsConsent,
            smsConsentAt: user.smsConsentAt,
            termsAccepted: user.termsAccepted,
            termsAcceptedAt: user.termsAcceptedAt,
            privacyAccepted: user.privacyAccepted,
            privacyAcceptedAt: user.privacyAcceptedAt,
            lastSuccessfulLoginAt: new Date(),
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

      await Db.savePasswordResetToken(
        User,
        user._id,
        resetToken,
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

      const user = await Db.findUserByPasswordResetToken(User, resetToken);

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
