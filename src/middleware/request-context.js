import crypto from "crypto";

import logger from "../config/logger.js";
import { getRuntimeConfig } from "../config/env.js";

const requestContext = (req, res, next) => {
  const incomingId = String(req.headers["x-request-id"] || "").trim();
  const requestId =
    incomingId && incomingId.length <= 128 ? incomingId : crypto.randomUUID();

  const startedAt = process.hrtime.bigint();

  req.context = {
    ...(req.context || {}),
    requestId,
    startedAt: new Date(),
  };

  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const durationMs =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const metadata = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      userId: req.user?.userId,
      businessId: req.business?._id,
    };

    let config;
    try {
      config = getRuntimeConfig();
    } catch {
      config = { slowRequestMs: 1500 };
    }

    if (res.statusCode >= 500) {
      logger.error("http_request_completed", metadata);
    } else if (durationMs >= config.slowRequestMs) {
      logger.warn("slow_http_request", metadata);
    } else {
      logger.info("http_request_completed", metadata);
    }
  });

  next();
};

export default requestContext;
