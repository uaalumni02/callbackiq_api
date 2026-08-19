import crypto from "crypto";
import twilio from "twilio";

import Business from "../models/business.js";
import User from "../models/user.js";
import { sendEmailVerificationEmail } from "../helpers/email/mailer.js";
import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const securityError = (code, message, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

export const securityGateEnabled = (
  name,
  { productionDefault = true } = {},
) => {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return productionDefault && process.env.NODE_ENV === "production";
};

const hashToken = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const getVerifyClient = () => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const serviceSid = String(process.env.TWILIO_VERIFY_SERVICE_SID || "").trim();

  if (!accountSid || !authToken || !serviceSid) {
    throw securityError(
      "PHONE_VERIFICATION_NOT_CONFIGURED",
      "Phone verification is temporarily unavailable.",
      503,
    );
  }

  return {
    client: twilio(accountSid, authToken),
    serviceSid,
  };
};

const loadOwnerAndBusiness = async (ownerId) => {
  const [user, business] = await Promise.all([
    User.findById(ownerId),
    Business.findOne({ owner: ownerId }),
  ]);

  if (!user) {
    throw securityError("USER_NOT_FOUND", "User account not found.", 404);
  }
  if (!business) {
    throw securityError("BUSINESS_NOT_FOUND", "Business not found.", 404);
  }

  return { user, business };
};

export const issueEmailVerification = async ({ user }) => {
  if (!user?._id || !user?.email) {
    throw securityError(
      "EMAIL_VERIFICATION_ACCOUNT_REQUIRED",
      "A valid account email is required.",
    );
  }

  if (user.emailVerifiedAt) {
    return { sent: false, alreadyVerified: true };
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: expiresAt,
      },
    },
  );

  await sendEmailVerificationEmail({
    email: user.email,
    token: rawToken,
  });

  return {
    sent: true,
    expiresAt,
    ...(process.env.NODE_ENV === "test" ? { verificationToken: rawToken } : {}),
  };
};

export const resendEmailVerification = async (ownerId) => {
  const user = await User.findById(ownerId);
  if (!user) {
    throw securityError("USER_NOT_FOUND", "User account not found.", 404);
  }
  return issueEmailVerification({ user });
};

export const verifyEmailToken = async (token) => {
  const normalized = String(token || "").trim();
  if (!normalized || normalized.length > 512) {
    throw securityError(
      "EMAIL_VERIFICATION_TOKEN_INVALID",
      "The email verification link is invalid or expired.",
      400,
    );
  }

  const tokenHash = hashToken(normalized);
  const user = await User.findOne({
    emailVerificationTokenHash: tokenHash,
    emailVerificationExpiresAt: { $gt: new Date() },
  }).select("+emailVerificationTokenHash +emailVerificationExpiresAt");

  if (!user) {
    throw securityError(
      "EMAIL_VERIFICATION_TOKEN_INVALID",
      "The email verification link is invalid or expired.",
      400,
    );
  }

  const now = new Date();
  await User.updateOne(
    { _id: user._id, emailVerificationTokenHash: tokenHash },
    {
      $set: { emailVerifiedAt: now },
      $unset: {
        emailVerificationTokenHash: 1,
        emailVerificationExpiresAt: 1,
      },
    },
  );

  return { emailVerified: true, emailVerifiedAt: now };
};

export const startForwardingPhoneVerification = async ({
  ownerId,
  channel = "sms",
}) => {
  const { business } = await loadOwnerAndBusiness(ownerId);
  const phone = normalizePhoneToE164(business.forwardingPhone);

  if (!phone) {
    throw securityError(
      "FORWARDING_PHONE_REQUIRED",
      "Add a valid forwarding phone before verification.",
      409,
    );
  }

  const safeChannel = String(channel || "").toLowerCase() === "call"
    ? "call"
    : "sms";
  const { client, serviceSid } = getVerifyClient();

  const verification = await client.verify.v2
    .services(serviceSid)
    .verifications.create({
      to: phone,
      channel: safeChannel,
    });

  return {
    status: verification?.status || "pending",
    channel: safeChannel,
    phoneLast4: phone.slice(-4),
  };
};

export const checkForwardingPhoneVerification = async ({
  ownerId,
  code,
}) => {
  const { business } = await loadOwnerAndBusiness(ownerId);
  const phone = normalizePhoneToE164(business.forwardingPhone);
  const normalizedCode = String(code || "").trim();

  if (!phone) {
    throw securityError(
      "FORWARDING_PHONE_REQUIRED",
      "Add a valid forwarding phone before verification.",
      409,
    );
  }
  if (!/^[0-9]{4,10}$/.test(normalizedCode)) {
    throw securityError(
      "PHONE_VERIFICATION_CODE_INVALID",
      "Enter the verification code that was sent to your business phone.",
      400,
    );
  }

  const { client, serviceSid } = getVerifyClient();
  const result = await client.verify.v2
    .services(serviceSid)
    .verificationChecks.create({
      to: phone,
      code: normalizedCode,
    });

  if (String(result?.status || "").toLowerCase() !== "approved") {
    throw securityError(
      "PHONE_VERIFICATION_FAILED",
      "That verification code was not approved.",
      400,
    );
  }

  const now = new Date();
  await Business.updateOne(
    { _id: business._id, owner: ownerId },
    {
      $set: {
        forwardingPhoneVerifiedAt: now,
        forwardingPhoneVerifiedValue: phone,
      },
    },
  );

  return {
    phoneVerified: true,
    forwardingPhoneVerifiedAt: now,
    phoneLast4: phone.slice(-4),
  };
};

export const getTrialIdentityVerificationStatus = async (ownerId) => {
  const { user, business } = await loadOwnerAndBusiness(ownerId);
  const forwardingPhone = normalizePhoneToE164(business.forwardingPhone);
  const verifiedPhone = normalizePhoneToE164(
    business.forwardingPhoneVerifiedValue,
  );

  const emailRequired = securityGateEnabled(
    "TRIAL_REQUIRE_EMAIL_VERIFICATION",
  );
  const phoneRequired = securityGateEnabled(
    "TRIAL_REQUIRE_PHONE_VERIFICATION",
  );
  const turnstileRequired = securityGateEnabled(
    "TRIAL_TURNSTILE_REQUIRED",
  );

  const emailVerified = Boolean(user.emailVerifiedAt);
  const phoneVerified = Boolean(
    business.forwardingPhoneVerifiedAt &&
      forwardingPhone &&
      verifiedPhone === forwardingPhone,
  );

  return {
    emailVerified,
    emailVerifiedAt: user.emailVerifiedAt || null,
    phoneVerified,
    forwardingPhoneVerifiedAt:
      phoneVerified ? business.forwardingPhoneVerifiedAt : null,
    phoneLast4: forwardingPhone ? forwardingPhone.slice(-4) : "",
    requirements: {
      email: emailRequired,
      phone: phoneRequired,
      turnstile: turnstileRequired,
    },
    ready:
      (!emailRequired || emailVerified) &&
      (!phoneRequired || phoneVerified),
  };
};

export const assertTrialIdentityVerified = async ({
  ownerId,
  business,
}) => {
  if (!ownerId || !business?._id) {
    throw securityError(
      "TRIAL_IDENTITY_REQUIRED",
      "A valid account and business are required.",
      400,
    );
  }

  const status = await getTrialIdentityVerificationStatus(ownerId);

  if (status.requirements.email && !status.emailVerified) {
    throw securityError(
      "TRIAL_EMAIL_VERIFICATION_REQUIRED",
      "Verify your business email before activating the free trial.",
      403,
    );
  }

  if (status.requirements.phone && !status.phoneVerified) {
    throw securityError(
      "TRIAL_PHONE_VERIFICATION_REQUIRED",
      "Verify ownership of your forwarding phone before activating the free trial.",
      403,
    );
  }

  return status;
};

export default {
  securityGateEnabled,
  issueEmailVerification,
  resendEmailVerification,
  verifyEmailToken,
  startForwardingPhoneVerification,
  checkForwardingPhoneVerification,
  getTrialIdentityVerificationStatus,
  assertTrialIdentityVerified,
};
