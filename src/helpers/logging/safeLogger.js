import crypto from "crypto";

const isProduction = () =>
  String(process.env.NODE_ENV || "development").toLowerCase() === "production";

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

export const sanitizeLogDetails = (details = {}) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, sanitizeScalar(key, value)]),
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
