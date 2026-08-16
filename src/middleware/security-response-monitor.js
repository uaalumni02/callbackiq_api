import MonitoringService from "../services/monitoring.service.js";

const securityResponseMonitor = (req, res, next) => {
  res.once("finish", () => {
    const status = Number(res.statusCode || 0);
    const metadata = {
      requestId: req.requestId || "",
      method: req.method,
      path: req.originalUrl?.split("?")[0] || req.path || "",
      status,
    };

    if (status >= 500) {
      MonitoringService.captureEvent("http_5xx_response", metadata, "error");
    } else if (status === 429) {
      MonitoringService.captureEvent("http_rate_limited", metadata, "warn");
    }
  });

  return next();
};

export default securityResponseMonitor;
