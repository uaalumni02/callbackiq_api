import { safeConsole } from "../logging/safeLogger.js";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const toBoundedInteger = (value, fallback, minimum, maximum) => {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsedValue));
};

const getClientIp = (req) => {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "";
};

const verifyTurnstileToken = async (token, req, options = {}) => {
  const secretKey = String(process.env.TURNSTILE_SECRET_KEY || "").trim();

  if (!secretKey) {
    safeConsole.error(
      "TURNSTILE_SECRET_KEY is not configured. Security challenge cannot be verified.",
    );

    return {
      success: false,
      reason: "challenge_not_configured",
    };
  }

  const normalizedToken = typeof token === "string" ? token.trim() : "";

  if (!normalizedToken) {
    return {
      success: false,
      reason: "challenge_token_missing",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => {
      controller.abort();
    },
    toBoundedInteger(process.env.TURNSTILE_TIMEOUT_MS, 5000, 1000, 30000),
  );

  try {
    const formData = new URLSearchParams();

    formData.append("secret", secretKey);
    formData.append("response", normalizedToken);

    const clientIp = getClientIp(req);

    if (clientIp) {
      formData.append("remoteip", clientIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      safeConsole.error(
        `Turnstile verification failed with status ${response.status}`,
      );

      return {
        success: false,
        reason: "challenge_service_error",
      };
    }

    const result = await response.json();

    const expectedHostname = String(
      process.env.TURNSTILE_EXPECTED_HOSTNAME || "",
    ).trim();

    const expectedAction = String(
      options.expectedAction ||
        process.env.TURNSTILE_EXPECTED_ACTION ||
        "",
    ).trim();

    const hostnameMatches =
      !expectedHostname || result.hostname === expectedHostname;

    const actionMatches = !expectedAction || result.action === expectedAction;

    const success = result.success === true && hostnameMatches && actionMatches;

    return {
      success,
      reason: success ? null : "challenge_invalid",
      errors: Array.isArray(result["error-codes"]) ? result["error-codes"] : [],
    };
  } catch (error) {
    safeConsole.error("Turnstile verification error:", {
      message: error?.message || "Unknown Turnstile error",
      name: error?.name || null,
    });

    return {
      success: false,
      reason: "challenge_service_error",
    };
  } finally {
    clearTimeout(timeout);
  }
};

export { getClientIp, verifyTurnstileToken };
