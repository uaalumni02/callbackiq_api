const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const getClientIp = (req) => {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "";
};

const verifyTurnstileToken = async (token, req) => {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;

  if (!secretKey) {
    console.error(
      "TURNSTILE_SECRET_KEY is not configured. Security challenge cannot be verified.",
    );

    return {
      success: false,
      reason: "challenge_not_configured",
    };
  }

  if (!token || typeof token !== "string") {
    return {
      success: false,
      reason: "challenge_token_missing",
    };
  }

  try {
    const formData = new URLSearchParams();

    formData.append("secret", secretKey);
    formData.append("response", token);

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
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error(
        `Turnstile verification failed with status ${response.status}`,
      );

      return {
        success: false,
        reason: "challenge_service_error",
      };
    }

    const result = await response.json();

    return {
      success: result.success === true,
      reason: result.success === true ? null : "challenge_invalid",
      errors: Array.isArray(result["error-codes"]) ? result["error-codes"] : [],
    };
  } catch (error) {
    console.error("Turnstile verification error:", error);

    return {
      success: false,
      reason: "challenge_service_error",
    };
  }
};

export { verifyTurnstileToken };
