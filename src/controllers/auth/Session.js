import { DUMMY_PASSWORD_HASH, Db, GENERIC_LOGIN_MESSAGE, Response, User, bcrypt, buildAuthToken, clearCookieOptions, cookieOptions, getRetryAfterSeconds, hasSecurityStateExpired, loginSchema, safeConsole, shouldExposeAuthToken, verifyTurnstileToken } from './context.js';

export default class AuthSessionController {
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
