import { isAllowedOrigin } from "../config/cors.js";
import MonitoringService from "../services/monitoring.service.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isEnabled = () => {
  if (String(process.env.CSRF_ORIGIN_GUARD_ENABLED || "").toLowerCase() === "false") {
    return false;
  }

  if (String(process.env.CSRF_ORIGIN_GUARD_ENABLED || "").toLowerCase() === "true") {
    return true;
  }

  return process.env.NODE_ENV === "production";
};

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== "string") return "";
  return authorizationHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
};

const getRefererOrigin = (referer) => {
  if (!referer) return "";

  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
};

const requestOrigin = (req) => {
  const protocol = req.protocol || "https";
  const host = req.get("host");

  return host ? `${protocol}://${host}` : "";
};

const csrfOriginGuard = (req, res, next) => {
  if (!isEnabled() || !UNSAFE_METHODS.has(String(req.method || "").toUpperCase())) {
    return next();
  }

  /*
   * Only auto-sent cookie authentication creates the CSRF condition.
   * Provider webhooks and server-to-server requests do not carry this cookie.
   * Bearer-authenticated requests require an explicit credential that a simple
   * cross-site form cannot manufacture.
   */
  const cookieToken = req.cookies?.token || "";
  if (!cookieToken || getBearerToken(req.get("authorization"))) {
    return next();
  }

  const origin = req.get("origin") || getRefererOrigin(req.get("referer"));
  const sameOrigin = origin && origin === requestOrigin(req);
  const allowed = origin && (sameOrigin || isAllowedOrigin(origin));

  if (allowed) {
    return next();
  }

  const allowMissing =
    String(process.env.CSRF_ALLOW_MISSING_ORIGIN || "").toLowerCase() === "true";

  if (!origin && allowMissing) {
    return next();
  }

  MonitoringService.captureEvent(
    "csrf_origin_rejected",
    {
      requestId: req.requestId || "",
      method: req.method,
      path: req.originalUrl?.split("?")[0] || req.path || "",
      reason: origin ? "origin_not_allowed" : "origin_missing",
    },
    "warn",
  );

  return res.status(403).json({
    success: false,
    message: "Request origin could not be verified",
    code: "CSRF_ORIGIN_REJECTED",
  });
};

export default csrfOriginGuard;
