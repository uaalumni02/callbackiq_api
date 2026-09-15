import { queryFailure } from "../services/scale/queryBudget.js";
import MonitoringService from "../services/monitoring.service.js";

const errorHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (queryFailure(error) || ["CACHE_REFRESH_BUSY", "CACHE_LOADER_TIMEOUT"].includes(error?.code)) {
    return res.status(503).set("Retry-After", "2").json({ success: false,
      code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
  }
  const requestId = req.context?.requestId || "";
  const statusCode =
    Number.isInteger(error?.statusCode) && error.statusCode >= 400
      ? error.statusCode
      : 500;

  MonitoringService.captureError("unhandled_api_error", error, {
    requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    userId: req.user?.userId,
    businessId: req.business?._id,
  });

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500
        ? "An unexpected server error occurred."
        : error.message || "Request failed.",
    requestId,
  });
};

export default errorHandler;
