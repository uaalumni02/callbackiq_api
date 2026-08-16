import logger from "../config/logger.js";
import SecurityAlertService from "./securityAlert.service.js";

const CRITICAL_EVENTS = new Set([
  "database_unavailable",
  "stripe_webhook_failed",
  "twilio_webhook_failed",
  "twilio_delivery_failed",
  "safety_escalation_failed",
  "environment_invalid",
  "unhandled_api_error",
  "csrf_origin_rejected",
  "auth_rate_limit_triggered",
  "http_5xx_response",
]);

const normalizeError = (error) => ({
  name: error?.name || "Error",
  message: error?.message || String(error || "Unknown error"),
  code: error?.code || "",
});

const dispatchCriticalAlert = (event, metadata, severity = "error") => {
  if (!CRITICAL_EVENTS.has(event)) return;

  void SecurityAlertService.dispatch(event, metadata, severity).catch(() => {
    // Alert delivery must never alter request behavior.
  });
};

class MonitoringService {
  static captureEvent(event, metadata = {}, level = "info") {
    const selectedLevel = CRITICAL_EVENTS.has(event) ? "error" : level;
    const record =
      logger[selectedLevel]?.(event, metadata) || logger.info(event, metadata);
    dispatchCriticalAlert(event, metadata, selectedLevel);
    return record;
  }

  static captureError(event, error, metadata = {}) {
    const normalizedMetadata = {
      ...metadata,
      error: normalizeError(error),
    };
    const record = logger.error(event, normalizedMetadata);
    dispatchCriticalAlert(event, normalizedMetadata, "error");
    return record;
  }

  static captureProviderFailure(provider, operation, error, metadata = {}) {
    return MonitoringService.captureError(
      `${provider}_${operation}_failed`,
      error,
      {
        provider,
        operation,
        ...metadata,
      },
    );
  }

  static captureSafetyEscalation(metadata = {}) {
    return MonitoringService.captureEvent(
      "unusual_safety_escalation",
      metadata,
      "warn",
    );
  }
}

export default MonitoringService;
