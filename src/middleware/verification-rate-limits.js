import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const ipKey = (req) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return ip === "unknown" ? ip : ipKeyGenerator(ip);
};

const userIpKey = (req) =>
  `${req.user?.userId || "anonymous"}:${ipKey(req)}`;

const makeLimiter = ({ limit, code }) =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: userIpKey,
    message: {
      success: false,
      code,
      message: "Too many verification attempts. Please try again later.",
    },
  });

export const emailVerificationRequestRateLimit = makeLimiter({
  limit: positiveInteger(
    process.env.EMAIL_VERIFICATION_REQUESTS_PER_HOUR,
    5,
  ),
  code: "EMAIL_VERIFICATION_RATE_LIMIT",
});

export const emailVerificationSubmitRateLimit = makeLimiter({
  limit: positiveInteger(
    process.env.EMAIL_VERIFICATION_SUBMISSIONS_PER_HOUR,
    20,
  ),
  code: "EMAIL_VERIFICATION_SUBMIT_RATE_LIMIT",
});

export const phoneVerificationStartRateLimit = makeLimiter({
  limit: positiveInteger(
    process.env.PHONE_VERIFICATION_STARTS_PER_HOUR,
    5,
  ),
  code: "PHONE_VERIFICATION_RATE_LIMIT",
});

export const phoneVerificationCheckRateLimit = makeLimiter({
  limit: positiveInteger(
    process.env.PHONE_VERIFICATION_CHECKS_PER_HOUR,
    10,
  ),
  code: "PHONE_VERIFICATION_CHECK_RATE_LIMIT",
});
