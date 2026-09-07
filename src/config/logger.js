import { safeConsole } from "../helpers/logging/safeLogger.js";
const SECRET_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|passcode|api[-_]?key|auth[-_]?token|private[-_]?key|signature)/i;

const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

const maskPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return "[REDACTED_PHONE]";
  return `***-***-${digits.slice(-4)}`;
};

const sanitizeString = (value) =>
  String(value)
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(PHONE_PATTERN, (match) => maskPhone(match));

export const redactLogValue = (value, key = "", seen = new WeakSet()) => {
  if (SECRET_KEY_PATTERN.test(String(key))) return "[REDACTED]";

  if (typeof value === "string") return sanitizeString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      code: value.code,
      stack:
        process.env.NODE_ENV === "production"
          ? undefined
          : sanitizeString(value.stack || ""),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, "", seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactLogValue(entryValue, entryKey, seen),
    ]),
  );
};

const emit = (level, event, metadata = {}) => {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    ...redactLogValue(metadata),
  };

  const line = JSON.stringify(record);

  if (level === "error" || level === "fatal") {
    safeConsole.error(line);
  } else if (level === "warn") {
    safeConsole.warn(line);
  } else {
    safeConsole.log(line);
  }

  return record;
};

const logger = Object.freeze({
  debug(event, metadata) {
    if ((process.env.LOG_LEVEL || "info") === "debug") {
      return emit("debug", event, metadata);
    }
    return null;
  },
  info(event, metadata) {
    return emit("info", event, metadata);
  },
  warn(event, metadata) {
    return emit("warn", event, metadata);
  },
  error(event, metadata) {
    return emit("error", event, metadata);
  },
  fatal(event, metadata) {
    return emit("fatal", event, metadata);
  },
});

export { maskPhone };
export default logger;
