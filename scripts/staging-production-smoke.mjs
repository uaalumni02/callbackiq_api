#!/usr/bin/env node

/*
 * READ-ONLY staging smoke test.
 *
 * This script intentionally does NOT:
 * - register a customer
 * - purchase a Twilio number
 * - attach/detach a Twilio sender
 * - submit A2P registration
 * - send SMS
 * - create Stripe Checkout/subscriptions
 * - create/update/delete Google Calendar events
 * - create/reschedule/cancel appointments
 *
 * It checks an ALREADY-PROVISIONED staging business through CallBackIQ's own
 * API using GET/HEAD only.
 */

const baseUrl = String(process.env.STAGING_API_BASE_URL || "").trim();
const bearerToken = String(process.env.STAGING_TEST_BEARER_TOKEN || "").trim();

if (!baseUrl) {
  console.error("STAGING_API_BASE_URL is required.");
  process.exit(1);
}

let base;
try {
  base = new URL(baseUrl);
} catch {
  console.error("STAGING_API_BASE_URL must be a valid URL.");
  process.exit(1);
}

if (!["https:", "http:"].includes(base.protocol)) {
  console.error("Only http/https staging URLs are supported.");
  process.exit(1);
}

if (
  base.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "::1"].includes(base.hostname)
) {
  console.error("Non-local staging smoke tests must use HTTPS.");
  process.exit(1);
}

if (process.env.STAGING_CONFIRM_PREPROVISIONED_RESOURCES !== "yes") {
  console.error(
    "Set STAGING_CONFIRM_PREPROVISIONED_RESOURCES=yes after confirming the staging business already has its test number/resources.",
  );
  process.exit(1);
}

const headers = {
  Accept: "application/json",
  ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
};

const safeRequest = async (path, { method = "GET", accepted = [] } = {}) => {
  const normalizedMethod = String(method).toUpperCase();

  if (!["GET", "HEAD"].includes(normalizedMethod)) {
    throw new Error(
      `Unsafe staging smoke method rejected: ${normalizedMethod}. This script is read-only.`,
    );
  }

  const url = new URL(path, base);
  const response = await fetch(url, {
    method: normalizedMethod,
    headers,
    redirect: "manual",
  });

  const ok =
    response.ok ||
    accepted.includes(response.status);

  if (!ok) {
    throw new Error(
      `${normalizedMethod} ${url.pathname} returned ${response.status}`,
    );
  }

  let body = null;
  if (normalizedMethod !== "HEAD") {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      body = await response.text();
    }
  }

  return { response, body };
};

const deepFind = (value, keys) => {
  if (!value || typeof value !== "object") return undefined;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  }

  for (const child of Object.values(value)) {
    const found = deepFind(child, keys);
    if (found !== undefined) return found;
  }

  return undefined;
};

const checks = [];

const runCheck = async (name, fn) => {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
    console.error(`✕ ${name} — ${error.message}`);
  }
};

console.log("\nCallBackIQ READ-ONLY staging smoke test");
console.log(`Target: ${base.origin}`);
console.log("Allowed methods: GET, HEAD only");
console.log("Provider resource creation: DISABLED BY DESIGN\n");

const healthPath = String(process.env.STAGING_HEALTH_PATH || "/health").trim();
if (healthPath) {
  await runCheck("API health/reachability", async () => {
    const { response } = await safeRequest(healthPath, {
      accepted: [401, 403, 404],
    });
    return `HTTP ${response.status}`;
  });
}

const webhookPath = String(
  process.env.STAGING_TWILIO_WEBHOOK_PATH || "/api/twilio/sms",
).trim();

if (webhookPath) {
  await runCheck("Twilio webhook route is reachable", async () => {
    const { response } = await safeRequest(webhookPath, {
      method: "HEAD",
      // 400/401/403 means the route/app rejected an unsigned request;
      // 405 means HEAD is unsupported but the endpoint is reachable.
      accepted: [400, 401, 403, 405],
    });
    return `HTTP ${response.status}`;
  });
}

const businessPath = String(
  process.env.STAGING_BUSINESS_STATUS_PATH || "/api/business/mine",
).trim();

if (businessPath) {
  await runCheck("Existing staging business is readable", async () => {
    if (!bearerToken) {
      throw new Error(
        "STAGING_TEST_BEARER_TOKEN is required for authenticated business checks.",
      );
    }

    const { body } = await safeRequest(businessPath);

    const smsReady = deepFind(body, ["smsReady"]);
    const senderAttached = deepFind(body, ["senderAttached"]);
    const a2pStatus = deepFind(body, ["a2pStatus"]);
    const campaignStatus = deepFind(body, ["campaignStatus"]);

    if (smsReady !== true) {
      throw new Error(
        `Expected existing staging business smsReady=true; received ${String(smsReady)}`,
      );
    }

    const pieces = [
      `smsReady=${smsReady}`,
      senderAttached !== undefined
        ? `senderAttached=${senderAttached}`
        : null,
      a2pStatus !== undefined ? `a2pStatus=${a2pStatus}` : null,
      campaignStatus !== undefined
        ? `campaignStatus=${campaignStatus}`
        : null,
    ].filter(Boolean);

    return pieces.join(", ");
  });
}

const appointmentsPath = String(
  process.env.STAGING_APPOINTMENTS_PATH || "/api/appointments",
).trim();

if (appointmentsPath) {
  await runCheck("Owner appointment API is readable", async () => {
    if (!bearerToken) {
      throw new Error(
        "STAGING_TEST_BEARER_TOKEN is required for appointment checks.",
      );
    }

    const { response } = await safeRequest(appointmentsPath);
    return `HTTP ${response.status}`;
  });
}

const failed = checks.filter((check) => !check.ok);

console.log("");
if (failed.length) {
  console.error(
    `Staging smoke result: FAIL (${failed.length}/${checks.length} checks failed)`,
  );
  process.exit(1);
}

console.log(`Staging smoke result: PASS (${checks.length} checks)`);
console.log(
  "No POST/PUT/PATCH/DELETE requests were made; no Twilio/Stripe/Google resources were created.\n",
);
