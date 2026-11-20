




import Token from "../../helpers/jwt/token.js";

import crypto from "crypto";








import { getTrustedRequestIp } from "../../helpers/security/trustedRequestIp.js";
import "mongoose";


const isProduction = ["production", "staging"].includes(process.env.NODE_ENV);

const cookieSameSite = ["lax", "strict", "none"].includes(process.env.AUTH_COOKIE_SAME_SITE) ? process.env.AUTH_COOKIE_SAME_SITE : (isProduction ? "none" : "lax");

const shouldExposeAuthToken = !isProduction &&
  process.env.AUTH_RESPONSE_TOKEN_ENABLED !== "false";

const hashPasswordResetToken = (token) =>
  crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: cookieSameSite,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

const clearCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: cookieSameSite,
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
    return "Account created successfully. Activate your 14-day trial to start MeekCall.";
  }
  if (eligibility?.reason === "disposable_email") {
    return "Account created successfully. This email domain is not eligible for a free trial, so choose a paid plan to activate MeekCall.";
  }
  return "Account created successfully. This customer or business identity has already used its lifetime free trial, so choose a paid plan to activate MeekCall.";
};

const getConsentIp = (req) => getTrustedRequestIp(req);

const buildAuthToken = (user, fallbackSessionVersion = 0, authentication = {}) =>
  Token.sign({
    ...authentication,
    userId: user._id,
    userName: user.userName,
    email: user.email,
    role: user.role,
    sessionVersion: Number(
      user.sessionVersion ?? fallbackSessionVersion ?? 0,
    ),
  });

export { buildAuthToken, cookieOptions, getConsentIp, shouldExposeAuthToken, trialEligibilityMessage, DUMMY_PASSWORD_HASH, GENERIC_LOGIN_MESSAGE, getRetryAfterSeconds, hasSecurityStateExpired, hashPasswordResetToken, clearCookieOptions };
