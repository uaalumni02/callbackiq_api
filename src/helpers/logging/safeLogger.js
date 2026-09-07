import crypto from "crypto";

const isProduction = () =>
  String(process.env.NODE_ENV || "development").toLowerCase() === "production" || String(process.env.NODE_ENV).toLowerCase() === "staging";

const shortHash = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
};

export const redactPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `***${digits.slice(-4)}`;
};

export const redactProviderId = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
};

const sanitizeScalar = (key, value) => {
  const normalizedKey = String(key || "").toLowerCase();
  if (/secret|password|token|authorization|cookie|credential|api.?key/.test(normalizedKey)) return "[redacted]";
  if (/^(from|to|caller|called|phone|customerphone|transferphone)$/.test(normalizedKey)) {
    return redactPhone(value);
  }
  if (/body|message|transcript|prompt|address|email|name/.test(normalizedKey)) {
    return isProduction() ? `[redacted:${shortHash(value)}]` : String(value || "").slice(0, 180);
  }
  if (/sid|provider.*id|eventkey/.test(normalizedKey)) {
    return redactProviderId(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (["string", "number", "boolean"].includes(typeof value) || value == null) {
    return value;
  }
  return String(value);
};

export const sanitizeLogDetails = (details = {}, depth = 0) => {
  if (depth > 4) return "[depth-limit]";
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  return Object.fromEntries(
    Object.entries(details).slice(0, 100).map(([key, value]) => [key, value && typeof value === "object" && !(value instanceof Date) && !/secret|token|password|auth|cookie|body|message|transcript|prompt|address|email|name/i.test(key) ? (Array.isArray(value) ? value.slice(0, 20).map(item => typeof item === "object" ? sanitizeLogDetails(item, depth + 1) : sanitizeScalar(key, item)) : sanitizeLogDetails(value, depth + 1)) : sanitizeScalar(key, value)]),
  );
};

export const sanitizeError = (error) => {
  const message = String(error?.message || "Unknown error");
  return {
    name: String(error?.name || "Error"),
    message: isProduction()
      ? `[redacted:${shortHash(message)}]`
      : message.slice(0, 500),
    code: error?.code || null,
    status: error?.status || error?.statusCode || null,
  };
};

export const logOperationalEvent = (event, details = {}) => {
  console.log(`[${event}]`, sanitizeLogDetails(details));
};

export const logOperationalWarning = (event, details = {}) => {
  console.warn(`[${event}]`, sanitizeLogDetails(details));
};

export const logOperationalError = (event, error, details = {}) => {
  console.error(`[${event}]`, {
    ...sanitizeLogDetails(details),
    error: sanitizeError(error),
  });
};

export default {
  redactPhone,
  redactProviderId,
  sanitizeLogDetails,
  sanitizeError,
  logOperationalEvent,
  logOperationalWarning,
  logOperationalError,
};

// Compatibility adapter for legacy call sites. Production free-form strings
// may contain interpolated customer details, so only structured numeric data
// and sanitized errors survive. New call sites should use named events above.
const sanitizeLoose = (value, depth = 0) => {
  if (depth > 5) return "[depth-limit]";
  if (value instanceof Error) return sanitizeError(value);
  if (typeof value === "string") return `[redacted:${shortHash(value)}]`;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeLoose(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, /secret|token|password|authorization|cookie|credential/i.test(key) ? "[redacted]" : sanitizeLoose(item, depth + 1)]));
  return value;
};
export const safeConsole = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace"].map(method => [method, (...args) => {
  if (!isProduction()) return console[method](...args);
  return console[method]({ event: `legacy.${method}`, details: args.map(arg => sanitizeLoose(arg)) });
}]));
