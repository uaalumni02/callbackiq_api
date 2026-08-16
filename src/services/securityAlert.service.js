import crypto from "crypto";
import logger, { redactLogValue } from "../config/logger.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MIN_INTERVAL_MS = 60000;
const lastSentAtByEvent = new Map();

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const validateAlertUrl = (value) => {
  if (!value) return null;

  try {
    const url = new URL(value);

    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      logger.error("security_alert_url_rejected", {
        reason: "https_required_in_production",
      });
      return null;
    }

    if (!["https:", "http:"].includes(url.protocol)) {
      logger.error("security_alert_url_rejected", {
        reason: "unsupported_protocol",
      });
      return null;
    }

    return url;
  } catch {
    logger.error("security_alert_url_rejected", {
      reason: "invalid_url",
    });
    return null;
  }
};

const shouldThrottle = (event) => {
  const minIntervalMs = toPositiveInteger(
    process.env.SECURITY_ALERT_MIN_INTERVAL_MS,
    DEFAULT_MIN_INTERVAL_MS,
  );
  const now = Date.now();
  const previous = lastSentAtByEvent.get(event) || 0;

  if (now - previous < minIntervalMs) {
    return true;
  }

  lastSentAtByEvent.set(event, now);
  return false;
};

const buildSignature = (body) => {
  const secret = process.env.SECURITY_ALERT_WEBHOOK_SECRET || "";
  if (!secret) return "";

  return `sha256=${crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex")}`;
};

class SecurityAlertService {
  static async dispatch(event, metadata = {}, severity = "error") {
    const url = validateAlertUrl(process.env.SECURITY_ALERT_WEBHOOK_URL);
    if (!url || shouldThrottle(event)) {
      return { delivered: false, skipped: true };
    }

    const payload = redactLogValue({
      source: "callbackiq_api",
      event,
      severity,
      environment:
        process.env.APP_ENV || process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
      metadata,
    });

    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      toPositiveInteger(
        process.env.SECURITY_ALERT_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      ),
    );

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "CallBackIQ-Security-Monitor/1.0",
    };

    const signature = buildSignature(body);
    if (signature) {
      headers["X-CallbackIQ-Signature"] = signature;
    }

    const bearer = process.env.SECURITY_ALERT_WEBHOOK_TOKEN || "";
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });

      if (!response.ok) {
        logger.warn("security_alert_delivery_failed", {
          event,
          status: response.status,
        });
        return { delivered: false, status: response.status };
      }

      return { delivered: true, status: response.status };
    } catch (error) {
      logger.warn("security_alert_delivery_failed", {
        event,
        error,
      });
      return { delivered: false, error: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default SecurityAlertService;
