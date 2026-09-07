import { safeConsole } from "../helpers/logging/safeLogger.js";
// CALLBACKIQ_PRODUCTION_HARDENING_V1
import crypto from "crypto";
import RequestRateLimitBucket from "../models/requestRateLimitBucket.js";
import { isProductionLike } from "../config/runtime-environment.js";

const enabled = () =>
  isProductionLike() ||
  String(process.env.DISTRIBUTED_AUTH_RATE_LIMIT_ENABLED || "").toLowerCase() ===
    "true";

const clientKey = (req) => {
  const source = String(
    req.ip || req.socket?.remoteAddress || "unknown-client",
  ).trim();
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
};

const fixedWindow = (windowMs) => {
  const now = Date.now();
  const start = Math.floor(now / windowMs) * windowMs;
  return {
    start,
    expiresAt: new Date(start + windowMs + 60000),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((start + windowMs - now) / 1000),
    ),
  };
};

export const createDistributedAuthRateLimit = ({
  scope,
  windowMs,
  limit,
}) => {
  if (!scope || !Number.isFinite(windowMs) || !Number.isFinite(limit)) {
    throw new Error("Invalid distributed rate-limit configuration");
  }

  return async (req, res, next) => {
    if (!enabled()) return next();

    const window = fixedWindow(windowMs);
    const bucketId = `${scope}:${window.start}:${clientKey(req)}`;

    try {
      const bucket = await RequestRateLimitBucket.findOneAndUpdate(
        { _id: bucketId },
        {
          $inc: { count: 1 },
          $setOnInsert: { expiresAt: window.expiresAt },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
        },
      ).lean();

      if (Number(bucket?.count || 0) <= limit) return next();

      res.set("Retry-After", String(window.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: "Too many requests. Please try again later.",
      });
    } catch (error) {
      safeConsole.error("Distributed auth rate limiter failed:", {
        scope,
        error: error?.message || String(error),
      });

      const failClosed =
        isProductionLike() &&
        String(process.env.AUTH_RATE_LIMIT_FAIL_CLOSED || "true").toLowerCase() !==
          "false";

      if (!failClosed) return next();

      return res.status(503).json({
        success: false,
        message: "Authentication service temporarily unavailable",
      });
    }
  };
};

export const distributedRegisterRateLimit = createDistributedAuthRateLimit({
  scope: "auth-register",
  windowMs: 60 * 60 * 1000,
  limit: 10,
});

export const distributedLoginRateLimit = createDistributedAuthRateLimit({
  scope: "auth-login",
  windowMs: 15 * 60 * 1000,
  limit: 20,
});

export const distributedPasswordResetRequestRateLimit =
  createDistributedAuthRateLimit({
    scope: "auth-password-reset-request",
    windowMs: 15 * 60 * 1000,
    limit: 5,
  });

export const distributedPasswordResetSubmitRateLimit =
  createDistributedAuthRateLimit({
    scope: "auth-password-reset-submit",
    windowMs: 15 * 60 * 1000,
    limit: 10,
  });
