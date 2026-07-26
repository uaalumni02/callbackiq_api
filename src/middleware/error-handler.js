import MonitoringService from "../services/monitoring.service.js";

const errorHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
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
