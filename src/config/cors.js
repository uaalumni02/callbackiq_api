const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:5173",
  process.env.CLIENT_URL,
].filter(Boolean);

/**
 * Determines whether an origin is allowed to access CallBackIQ.
 *
 * Requests without an Origin header are allowed because they may come from
 * server-to-server clients, development tools, mobile applications, or
 * same-origin requests.
 */
const isAllowedOrigin = (origin) => {
  return !origin || allowedOrigins.includes(origin);
};

/**
 * Shared CORS origin validator for Express.
 */
const corsOrigin = (origin, callback) => {
  if (isAllowedOrigin(origin)) {
    return callback(null, true);
  }

  return callback(new Error(`CORS blocked origin: ${origin}`));
};

/**
 * Shared Express CORS configuration.
 */
const expressCorsOptions = {
  origin: corsOrigin,
  credentials: true,
};

/**
 * Shared Socket.IO CORS configuration.
 *
 * Socket.IO accepts an array of trusted origins, while Express uses the
 * callback above so requests without an Origin header can also be handled.
 */
const socketCorsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST"],
};

export {
  allowedOrigins,
  isAllowedOrigin,
  corsOrigin,
  expressCorsOptions,
  socketCorsOptions,
};
