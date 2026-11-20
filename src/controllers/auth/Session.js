import { issueAdminChallenge } from '../../services/security/adminMfa.service.js';
import "mongoose";
import { DUMMY_PASSWORD_HASH, GENERIC_LOGIN_MESSAGE, buildAuthToken, clearCookieOptions, cookieOptions, getRetryAfterSeconds, hasSecurityStateExpired, shouldExposeAuthToken } from "./helpers.js";
import Db from "../../db/db.js";
import * as Response from "../../helpers/response/response.js";
import User from "../../models/user.js";
import bcrypt from "../../helpers/bcrypt/bcrypt.js";
import { loginSchema } from "../../validator/auth.js";
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import { verifyTurnstileToken } from "../../helpers/security/turnstile.js";

export default class AuthSessionController {
static async login(req, res) {
    const { login, password, securityChallengeToken = "" } = req.body;

    try {
      await loginSchema.validateAsync(req.body);

      const normalizedLogin = login.trim();
      let user = await Db.findUserByLogin(User, normalizedLogin);

      const passwordHash = user?.password || DUMMY_PASSWORD_HASH;
      const isMatch = await bcrypt.comparePassword(password, passwordHash);

      if (!user) {
        return Response.responseBadAuth(res, GENERIC_LOGIN_MESSAGE);
      }

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

      if (retryAfterSeconds > 0) {
        return Response.responseBadAuth(res, GENERIC_LOGIN_MESSAGE);
      }

      if (!isMatch) {
        await Db.recordFailedLogin(User, user._id);

        return Response.responseBadAuth(res, GENERIC_LOGIN_MESSAGE);
      }

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

      const authenticatedUser =
        (await Db.clearLoginSecurityState(User, user._id)) || user;

      if (authenticatedUser.role === 'admin') {
        res.set('Cache-Control', 'no-store');
        return Response.responseOk(res, await issueAdminChallenge({ ...authenticatedUser.toObject(), sessionVersion: user.sessionVersion }), 'Complete administrator verification');
      }
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

      safeConsole.error("Login error:", error);
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
      safeConsole.error("Me error:", error);
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
      safeConsole.error("Logout error:", error);
      return Response.responseServerError(res);
    }
  }
}
