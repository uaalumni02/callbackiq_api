import { rateLimit } from "express-rate-limit";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_REQUESTS_PER_IP = 20;

const loginRateLimit = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_MAX_REQUESTS_PER_IP,

  standardHeaders: "draft-8",
  legacyHeaders: false,

  skipSuccessfulRequests: true,

  message: {
    success: false,
    message: "Too many login attempts. Please try again later.",
  },

  handler: (req, res, next, options) => {
    const resetTime = req.rateLimit?.resetTime;
    const retryAfterSeconds = resetTime
      ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
      : Math.ceil(LOGIN_WINDOW_MS / 1000);

    res.set("Retry-After", String(retryAfterSeconds));

    return res.status(options.statusCode).json({
      success: false,
      message: "Too many login attempts. Please try again later.",
    });
  },
});

export default loginRateLimit;
