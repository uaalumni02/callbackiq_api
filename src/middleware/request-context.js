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
  if (typeof res.json === 'function') {
    const json = res.json.bind(res);
    res.json = body => {
      if (res.statusCode < 400 || !body || typeof body !== 'object') return json(body);
      const retryable = res.statusCode === 429 || res.statusCode >= 500;
      return json({ code: res.statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED',
        retryable, requestId, ...body });
    };
  }

  res.on("finish", () => {
    const durationMs =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const metadata = {
      requestId,
      method: req.method,
      path: req.baseUrl + (req.route?.path || req.path.replace(/[^/]+/g, ":segment")),
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
