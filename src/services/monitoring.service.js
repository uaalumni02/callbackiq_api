import logger from "../config/logger.js";

const CRITICAL_EVENTS = new Set([
  "database_unavailable",
  "stripe_webhook_failed",
  "twilio_webhook_failed",
  "twilio_delivery_failed",
  "safety_escalation_failed",
  "environment_invalid",
]);

const normalizeError = (error) => ({
  name: error?.name || "Error",
  message: error?.message || String(error || "Unknown error"),
  code: error?.code || "",
});

class MonitoringService {
  static captureEvent(event, metadata = {}, level = "info") {
    const selectedLevel = CRITICAL_EVENTS.has(event) ? "error" : level;
    return logger[selectedLevel]?.(event, metadata) || logger.info(event, metadata);
  }

  static captureError(event, error, metadata = {}) {
    return logger.error(event, {
      ...metadata,
      error: normalizeError(error),
    });
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
