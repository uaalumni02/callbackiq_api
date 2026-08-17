import { rateLimit } from "express-rate-limit";
import MonitoringService from "../services/monitoring.service.js";

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const shouldSkipPublicAuthLimiter = () =>
  process.env.NODE_ENV === "test" &&
  process.env.TEST_AUTH_PUBLIC_RATE_LIMITS !== "true";

const createAuthLimiter = ({
  bucket,
  windowMs,
  limit,
}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: shouldSkipPublicAuthLimiter,
    handler: (req, res, _next, options) => {
      MonitoringService.captureEvent(
        "auth_rate_limit_triggered",
        {
          bucket,
          requestId: req.requestId || "",
          method: req.method,
          path: req.originalUrl?.split("?")[0] || req.path || "",
        },
        "warn",
      );

      return res.status(options.statusCode || 429).json({
        success: false,
        message: "Too many requests. Please try again later.",
        code: "RATE_LIMITED",
      });
    },
  });

const registerRateLimit = createAuthLimiter({
  bucket: "register",
  windowMs: positiveInteger(
    process.env.REGISTER_RATE_LIMIT_WINDOW_MS,
    60 * 60 * 1000,
  ),
  limit: positiveInteger(process.env.REGISTER_RATE_LIMIT_MAX, 10),
});

const passwordResetRequestRateLimit = createAuthLimiter({
  bucket: "password_reset_request",
  windowMs: positiveInteger(
    process.env.PASSWORD_RESET_REQUEST_RATE_LIMIT_WINDOW_MS,
    15 * 60 * 1000,
  ),
  limit: positiveInteger(process.env.PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX, 5),
});

const passwordResetSubmitRateLimit = createAuthLimiter({
  bucket: "password_reset_submit",
  windowMs: positiveInteger(
    process.env.PASSWORD_RESET_SUBMIT_RATE_LIMIT_WINDOW_MS,
    15 * 60 * 1000,
  ),
  limit: positiveInteger(process.env.PASSWORD_RESET_SUBMIT_RATE_LIMIT_MAX, 10),
});

export {
  registerRateLimit,
  passwordResetRequestRateLimit,
  passwordResetSubmitRateLimit,
};
