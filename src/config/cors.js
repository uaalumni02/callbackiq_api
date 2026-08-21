const normalizeOrigin = (value) => {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return "";
  }

  return normalizedValue.replace(/\/+$/, "");
};

const parseConfiguredOrigins = (...values) => {
  return values.flatMap((value) => {
    return String(value || "")
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean);
  });
};

const isProductionLike = ["production", "staging"].includes(
  String(process.env.NODE_ENV || "").trim().toLowerCase(),
);
const developmentOrigins = isProductionLike
  ? []
  : ["http://localhost:3001", "http://localhost:5173"];

const allowedOrigins = [
  ...developmentOrigins,
  ...parseConfiguredOrigins(
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGINS,
  ),
].filter((origin, index, origins) => origins.indexOf(origin) === index);

const allowedOriginSet = new Set(allowedOrigins);

/**
 * Determines whether an origin is allowed to access CallBackIQ.
 *
 * Requests without an Origin header are allowed because they may come from
 * server-to-server clients, development tools, mobile applications, same-origin
 * traffic, Stripe, or Twilio.
 */
const isAllowedOrigin = (origin) => {
  if (!origin) {
    return true;
  }

  return allowedOriginSet.has(normalizeOrigin(origin));
};

const corsOrigin = (origin, callback) => {
  if (isAllowedOrigin(origin)) {
    return callback(null, true);
  }

  return callback(new Error(`CORS blocked origin: ${origin}`));
};

const expressCorsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With", "Idempotency-Key"],
  maxAge: 86400,
};

/*
 * Socket.IO supports the same callback-style origin validation used by Express.
 * This also allows clients that do not send an Origin header.
 */
const socketCorsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ["GET", "POST"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400,
};

export {
  allowedOrigins,
  isAllowedOrigin,
  corsOrigin,
  expressCorsOptions,
  socketCorsOptions,
};
