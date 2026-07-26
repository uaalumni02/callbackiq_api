const VALID_ENVIRONMENTS = new Set([
  "development",
  "test",
  "staging",
  "production",
]);

const PLACEHOLDER_PATTERNS = [
  /^$/,
  /replace[-_ ]?me/i,
  /changeme/i,
  /example/i,
  /your[-_]/i,
  /<.*>/,
];

const COMMON_REQUIRED = [
  "MONGODB_URI",
  "JWT_SECRET",
  "CLIENT_URL",
  "PUBLIC_API_URL",
];

const PROVIDER_REQUIRED = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
];

const trimTrailingSlash = (value = "") =>
  String(value || "").trim().replace(/\/+$/, "");

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
};

const parseInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const parseCsv = (value = "") =>
  String(value || "")
    .split(",")
    .map((entry) => trimTrailingSlash(entry))
    .filter(Boolean);

const isPlaceholder = (value) =>
  PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(String(value ?? "")));

const isLocalUrl = (value) => {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
};

const validateUrl = (name, value, errors) => {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push(`${name} must use http or https.`);
    }
  } catch {
    errors.push(`${name} must be a valid absolute URL.`);
  }
};

export const validateEnvironment = (
  source = process.env,
  { throwOnError = true } = {},
) => {
  const appEnv = String(
    source.APP_ENV || source.NODE_ENV || "development",
  ).toLowerCase();

  const errors = [];
  const warnings = [];

  if (!VALID_ENVIRONMENTS.has(appEnv)) {
    errors.push(
      `APP_ENV must be one of: ${[...VALID_ENVIRONMENTS].join(", ")}.`,
    );
  }

  const required = [...COMMON_REQUIRED];

  if (["staging", "production"].includes(appEnv)) {
    required.push(...PROVIDER_REQUIRED);
  }

  for (const name of required) {
    if (isPlaceholder(source[name])) {
      errors.push(`${name} is required and cannot be a placeholder.`);
    }
  }

  if (source.JWT_SECRET && String(source.JWT_SECRET).length < 32) {
    errors.push("JWT_SECRET must contain at least 32 characters.");
  }

  for (const name of [
    "CLIENT_URL",
    "PUBLIC_API_URL",
    "TWILIO_WEBHOOK_BASE_URL",
  ]) {
    if (source[name]) validateUrl(name, source[name], errors);
  }

  if (["staging", "production"].includes(appEnv)) {
    for (const name of [
      "CLIENT_URL",
      "PUBLIC_API_URL",
      "TWILIO_WEBHOOK_BASE_URL",
    ]) {
      if (source[name] && isLocalUrl(source[name])) {
        errors.push(`${name} cannot use localhost in ${appEnv}.`);
      }
    }

    if (parseBoolean(source.ALLOW_UNSIGNED_PROVIDER_WEBHOOKS, false)) {
      errors.push(
        "ALLOW_UNSIGNED_PROVIDER_WEBHOOKS must be false in staging and production.",
      );
    }

    if (!parseBoolean(source.TWILIO_VALIDATE_SIGNATURES, true)) {
      errors.push(
        "TWILIO_VALIDATE_SIGNATURES must be true in staging and production.",
      );
    }

    if (
      appEnv === "production" &&
      String(source.STRIPE_SECRET_KEY || "").startsWith("sk_test_")
    ) {
      errors.push("Production cannot use a Stripe test secret key.");
    }

    if (
      appEnv === "staging" &&
      String(source.STRIPE_SECRET_KEY || "").startsWith("sk_live_")
    ) {
      errors.push("Staging cannot use a Stripe live secret key.");
    }
  }

  const allowedOrigins = parseCsv(
    source.ALLOWED_ORIGINS || source.CLIENT_URL || "",
  );

  if (allowedOrigins.length === 0) {
    errors.push("At least one allowed frontend origin is required.");
  }

  if (
    allowedOrigins.some((origin) => origin === "*") &&
    ["staging", "production"].includes(appEnv)
  ) {
    errors.push("Wildcard CORS origins are not allowed outside development.");
  }

  if (!source.DUMMY_PASSWORD_HASH) {
    warnings.push(
      "DUMMY_PASSWORD_HASH is not set; the built-in safe fallback will be used.",
    );
  }

  const result = {
    valid: errors.length === 0,
    errors,
    warnings,
    environment: appEnv,
  };

  if (!result.valid && throwOnError) {
    const error = new Error(
      `Invalid CallBackIQ environment:\n- ${errors.join("\n- ")}`,
    );
    error.code = "INVALID_ENVIRONMENT";
    error.details = result;
    throw error;
  }

  return result;
};

let cachedConfig;

export const getRuntimeConfig = (source = process.env) => {
  if (source === process.env && cachedConfig) return cachedConfig;

  const validation = validateEnvironment(source);

  const config = Object.freeze({
    environment: validation.environment,
    isProduction: validation.environment === "production",
    isStaging: validation.environment === "staging",
    port: parseInteger(source.PORT, 3000, 1, 65535),
    bodyLimit: source.API_BODY_LIMIT || "1mb",
    trustProxy: parseInteger(source.TRUST_PROXY, 1, 0, 10),
    clientUrl: trimTrailingSlash(source.CLIENT_URL),
    publicApiUrl: trimTrailingSlash(source.PUBLIC_API_URL),
    twilioWebhookBaseUrl: trimTrailingSlash(
      source.TWILIO_WEBHOOK_BASE_URL || source.PUBLIC_API_URL,
    ),
    allowedOrigins: parseCsv(
      source.ALLOWED_ORIGINS || source.CLIENT_URL || "",
    ),
    validateTwilioSignatures: parseBoolean(
      source.TWILIO_VALIDATE_SIGNATURES,
      true,
    ),
    allowUnsignedProviderWebhooks: parseBoolean(
      source.ALLOW_UNSIGNED_PROVIDER_WEBHOOKS,
      false,
    ),
    monitoringEnabled: parseBoolean(source.MONITORING_ENABLED, true),
    slowRequestMs: parseInteger(source.SLOW_REQUEST_MS, 1500, 100, 120000),
  });

  if (source === process.env) cachedConfig = config;
  return config;
};

export const resetRuntimeConfigForTests = () => {
  cachedConfig = undefined;
};

export {
  parseBoolean,
  parseCsv,
  parseInteger,
  trimTrailingSlash,
};
