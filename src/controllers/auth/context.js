import { safeConsole } from "../../helpers/logging/safeLogger.js";

import Db from "../../db/db.js";

import User from "../../models/user.js";

import Business from "../../models/business.js";

import { verifyTurnstileToken } from "../../helpers/security/turnstile.js";

import Token from "../../helpers/jwt/token.js";

import bcrypt from "../../helpers/bcrypt/bcrypt.js";

import crypto from "crypto";

import {
  registerSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "../../validator/auth.js";

import * as validate from "../../helpers/model/user.js";

import * as Response from "../../helpers/response/response.js";

import { normalizePhoneToE164 as normalizeBusinessPhone } from "../../voice/voicePhone.service.js";

import {
  createInactiveSubscription,
  getTrialEligibility,
} from "../../helpers/billing/trial.js";

import {
  issueEmailVerification,
  securityGateEnabled,
} from "../../services/trialIdentityVerification.service.js";

import { captureSignupSecurity } from "../../services/trialRisk.service.js";

import sendPasswordResetEmail from "../../helpers/email/mailer.js";

import { getTrustedRequestIp } from "../../helpers/security/trustedRequestIp.js";

import "mongoose";

import { runRegistrationTransaction } from "../../services/registrationTransaction.service.js";

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

export { Business, Db, Response, User, bcrypt, buildAuthToken, captureSignupSecurity, cookieOptions, createInactiveSubscription, crypto, getConsentIp, getTrialEligibility, issueEmailVerification, normalizeBusinessPhone, registerSchema, runRegistrationTransaction, safeConsole, securityGateEnabled, shouldExposeAuthToken, trialEligibilityMessage, validate, verifyTurnstileToken, DUMMY_PASSWORD_HASH, GENERIC_LOGIN_MESSAGE, getRetryAfterSeconds, hasSecurityStateExpired, loginSchema, hashPasswordResetToken, requestPasswordResetSchema, sendPasswordResetEmail, resetPasswordSchema, clearCookieOptions };
