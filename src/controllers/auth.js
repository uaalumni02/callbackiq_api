import Db from "../db/db.js";
import User from "../models/user.js";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
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

      if (!smsConsent) {
        return Response.responseInvalidInput(
          res,
          "SMS consent is required to create an account",
        );
      }

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

      const savedUser = await Db.saveUser(User, {
        userName,
        email,
        password: hashedPassword,
        role,
        businessName,
        businessPhone,
        businessType,

        smsConsent: true,
        smsConsentAt: now,
        smsConsentIp: req.ip || req.headers["x-forwarded-for"] || "",
        smsConsentUserAgent: req.headers["user-agent"] || "",

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

      const trialStartedAt = new Date();
      const trialEndsAt = new Date(trialStartedAt);
      trialEndsAt.setDate(trialEndsAt.getDate() + 14);

      const savedSubscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        savedBusiness._id,
        {
          plan: "pro",
          status: "trialing",
          trialStartedAt,
          trialEndsAt,
          currentPeriodStart: trialStartedAt,
          currentPeriodEnd: trialEndsAt,
          priceMonthly: 199,
          aiEnabled: true,
          isActive: true,
          cancelAtPeriodEnd: false,
          lastPaymentStatus: "trialing",
        },
      );

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
        },
        "Account created successfully",
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
    const { login, password } = req.body;

    try {
      await loginSchema.validateAsync(req.body);

      const user = await Db.findUserByLogin(User, login);

      if (!user) {
        return Response.responseBadAuth(res, "Invalid login or password");
      }

      const isMatch = await bcrypt.comparePassword(password, user.password);

      if (!isMatch) {
        return Response.responseBadAuth(res, "Invalid login or password");
      }

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
