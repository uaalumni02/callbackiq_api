import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const requestIpKey = (req) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return ip === "unknown" ? ip : ipKeyGenerator(ip);
};

const keyGenerator = (req) =>
  `${req.user?.userId || "anonymous"}:${requestIpKey(req)}`;

const trialActivationRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Math.max(1, Number(process.env.TRIAL_ACTIVATION_ATTEMPTS_PER_HOUR) || 5),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator,
  message: {
    success: false,
    code: "TRIAL_ACTIVATION_RATE_LIMIT",
    message:
      "Too many trial activation attempts. Please wait before trying again.",
  },
});

export default trialActivationRateLimit;
