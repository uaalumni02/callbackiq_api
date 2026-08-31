#!/usr/bin/env node

/**
 * CallBackIQ real-activity + load harness
 *
 * Goals:
 * - Exercise existing businesses only.
 * - Never register users, activate trials, provision numbers, purchase numbers,
 *   submit A2P registrations, or touch those endpoints.
 * - Put heavy load on CallBackIQ-owned API/database paths without generating a
 *   heavy volume of real Twilio calls/SMS.
 * - Offer separately gated, capped signed-webhook and live-phone smoke tests.
 * - Optionally smoke-test the React UI with Playwright.
 *
 * Recommended: run against a staging copy of production data/config first.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, "..");
const ORIGINAL_ENV_KEYS = new Set(Object.keys(process.env));
loadEnvFile(path.join(API_ROOT, ".env"), { overwriteNonShell: false });
loadEnvFile(path.join(__dirname, ".env"), { overwriteNonShell: true });

function loadEnvFile(filename, { overwriteNonShell }) {
  if (!fsSync.existsSync(filename)) return;
  const text = fsSync.readFileSync(filename, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key] = match;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    value = value.replace(/\n/g, "\n");
    if (ORIGINAL_ENV_KEYS.has(key)) continue;
    if (process.env[key] === undefined || overwriteNonShell) process.env[key] = value;
  }
}

const BUSINESSES = [
  {
    key: "atlanta",
    id: "6a33ff7944ce80eaef2cb543",
    ownerId: "6a33fd9444ce80eaef2cb542",
    name: "Atlanta Pro Plumbing & Drain",
    type: "plumbing",
    phone: "+14709052202",
    forwardingPhone: "+16785768258",
    timezone: "America/New_York",
    postalCode: "30303",
  },
  {
    key: "birmingham",
    id: "6a7e69e15ab394844b6ed9d2",
    ownerId: "6a7e69e15ab394844b6ed9d1",
    name: "Birmingham Plumbing",
    type: "plumbing",
    phone: "+12058397006",
    forwardingPhone: "+12052331434",
    timezone: "America/New_York",
    postalCode: "35203",
  },
];

const cfg = {
  apiBase: String(process.env.CALLBACKIQ_API_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, ""),
  uiBase: String(process.env.CALLBACKIQ_UI_BASE_URL || "http://127.0.0.1:3001").replace(/\/+$/, ""),
  allowRemote: yes("ALLOW_REMOTE_LOAD_TEST"),
  allowWrites: yes("ALLOW_SYNTHETIC_WRITES"),
  allowProviderSideEffects: yes("ALLOW_PROVIDER_SIDE_EFFECTS"),
  allowLiveCalls: yes("ALLOW_LIVE_CALLS"),
  allowLiveSms: yes("ALLOW_LIVE_SMS"),
  allowAttributionFixtures: yes("ALLOW_ATTRIBUTION_FIXTURES"),
  keepAttributionFixtures: yes("KEEP_ATTRIBUTION_FIXTURES"),
  strictAttributionPropagation: yes("STRICT_ATTRIBUTION_PROPAGATION"),
  attributionNumbersPerBusiness: boundedInt("ATTRIBUTION_NUMBERS_PER_BUSINESS", 3, 1, 8),
  webhookSignatureBase: String(process.env.TWILIO_WEBHOOK_SIGNATURE_BASE_URL || process.env.TWILIO_WEBHOOK_BASE_URL || process.env.CALLBACKIQ_API_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, ""),
  concurrency: boundedInt("LOAD_CONCURRENCY", 20, 1, 500),
  flowsPerBusiness: boundedInt("LOAD_FLOWS_PER_BUSINESS", 100, 1, 100000),
  timeoutMs: boundedInt("REQUEST_TIMEOUT_MS", 15000, 500, 120000),
  aiSamplesPerBusiness: boundedInt("AI_SAMPLES_PER_BUSINESS", 2, 0, 20),
  providerWebhookFlowsPerBusiness: boundedInt("PROVIDER_WEBHOOK_FLOWS_PER_BUSINESS", 2, 1, 10),
  maxLiveCallsTotal: boundedInt("MAX_LIVE_CALLS_TOTAL", 2, 1, 4),
  maxLiveSmsTotal: boundedInt("MAX_LIVE_SMS_TOTAL", 4, 1, 8),
  reportDir: String(process.env.REPORT_DIR || path.join(__dirname, "reports")),
  runTag: String(process.env.RUN_TAG || `load-${new Date().toISOString().replace(/[:.]/g, "-")}`),
};

function yes(name) {
  return ["1", "true", "yes", "y"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function boundedInt(name, fallback, min, max) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function assertTargetAllowed(baseUrl) {
  const url = new URL(baseUrl);
  const local = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!local.has(url.hostname) && !cfg.allowRemote) {
    throw new Error(
      `Refusing remote load test against ${url.hostname}. Set ALLOW_REMOTE_LOAD_TEST=yes only for an environment you own and intend to load-test.`,
    );
  }
  if (!local.has(url.hostname) && url.protocol !== "https:") {
    throw new Error("Non-local load tests must use HTTPS.");
  }
}

assertTargetAllowed(cfg.apiBase);

const metrics = [];
const failures = [];
const created = [];
const attributionResults = [];

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function id32(prefix) {
  return prefix + crypto.randomBytes(16).toString("hex").slice(0, 32);
}

function fakeCustomerPhone(index, businessIndex = 0) {
  const areaCodes = [
    "202", "212", "213", "305", "312",
    "404", "415", "470", "617", "646",
    "678", "702", "718", "770", "786",
    "813", "818", "832", "917", "929"
  ];

  /*
   * Give each load-test run an explicit synthetic phone namespace.
   *
   * The harness intentionally stays inside the NANP 555-0100..0199
   * fictional-number range because some harness modes exercise webhook
   * behavior and must never target an arbitrary real subscriber.
   *
   * LOAD_PHONE_NAMESPACE shifts the selected area-code block while the
   * flow index remains unique inside that block.
   */
  const namespaceRaw = Number.parseInt(
    process.env.LOAD_PHONE_NAMESPACE || "0",
    10
  );

  if (!Number.isInteger(namespaceRaw) || namespaceRaw < 0) {
    throw new Error(
      `Invalid LOAD_PHONE_NAMESPACE: ${process.env.LOAD_PHONE_NAMESPACE}`
    );
  }

  const slotsPerAreaCode = 100;

  /*
   * Namespace values wrap across the available fictional-number pools.
   * businessOffset keeps the two business workloads separated in their
   * deterministic sequence; uniqueness is still enforced by MongoDB.
   */
  const namespaceOffset =
    (namespaceRaw % areaCodes.length) * slotsPerAreaCode;

  const businessOffset = businessIndex * 1000;
  const uniqueIndex = businessOffset + namespaceOffset + index;

  const areaIndex =
    Math.floor(uniqueIndex / slotsPerAreaCode) % areaCodes.length;

  const lineNumber =
    100 + (uniqueIndex % slotsPerAreaCode);

  return `+1${areaCodes[areaIndex]}555${String(lineNumber).padStart(4, "0")}`;
}

function getDeep(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const key of p.split(".")) {
      if (cur == null || !(key in Object(cur))) { ok = false; break; }
      cur = cur[key];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function getId(payload, preferred = []) {
  const p = [
    ...preferred,
    "data._id", "data.id", "_id", "id",
    "data.lead._id", "lead._id",
    "data.conversation._id", "conversation._id",
    "data.message._id", "message._id",
    "data.callLog._id", "callLog._id",
    "data.appointment._id", "appointment._id",
  ];
  const found = getDeep(payload, p);
  return found ? String(found) : "";
}

function responseData(payload) {
  return payload?.data ?? payload;
}

class Session {
  constructor(business) {
    this.business = business;
    this.cookie = String(process.env[`COOKIE_${business.key.toUpperCase()}`] || "").trim();
    this.token = String(process.env[`BEARER_${business.key.toUpperCase()}`] || "").trim();
  }

  authHeaders() {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
  }

  async login() {
    if (this.cookie || this.token) return;
    const key = this.business.key.toUpperCase();
    const login = String(process.env[`LOGIN_${key}`] || "").trim();
    const password = String(process.env[`PASSWORD_${key}`] || "");
    if (!login || !password) {
      throw new Error(
        `No auth for ${this.business.name}. Set LOGIN_${key}/PASSWORD_${key}, COOKIE_${key}, or BEARER_${key}.`,
      );
    }
    const res = await rawRequest("POST", "/api/auth/login", {
      json: { login, password },
      label: `login:${this.business.key}`,
      recordMetric: false,
    });
    const setCookie = res.headers.get("set-cookie") || "";
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const bodyToken = getDeep(res.body, ["data.token", "token"]);
    if (bodyToken) this.token = String(bodyToken);
    if (!this.cookie && !this.token) throw new Error(`Login succeeded but no session credential was returned for ${this.business.name}.`);
  }

  request(method, route, options = {}) {
    return rawRequest(method, route, {
      ...options,
      headers: { ...this.authHeaders(), ...(options.headers || {}) },
    });
  }
}

async function rawRequest(method, route, {
  json,
  form,
  headers = {},
  accepted = [],
  label = `${method} ${route}`,
  recordMetric = true,
} = {}) {
  const url = route.startsWith("http") ? route : `${cfg.apiBase}${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const started = performance.now();
  try {
    const reqHeaders = { Accept: "application/json, text/plain, */*", ...headers };
    let body;
    if (json !== undefined) {
      reqHeaders["content-type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      reqHeaders["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const response = await fetch(url, { method, headers: reqHeaders, body, signal: controller.signal, redirect: "manual" });
    const contentType = response.headers.get("content-type") || "";
    let parsed;
    if (contentType.includes("application/json")) parsed = await response.json().catch(() => null);
    else parsed = await response.text().catch(() => "");
    const durationMs = performance.now() - started;
    const ok = response.ok || accepted.includes(response.status);
    if (recordMetric) metrics.push({ label, method, route: new URL(url).pathname, status: response.status, ok, durationMs });
    if (!ok) {
      const err = new Error(`${label} returned HTTP ${response.status}: ${typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 500)}`);
      err.status = response.status;
      err.body = parsed;
      throw err;
    }
    return { response, headers: response.headers, body: parsed, status: response.status, durationMs };
  } catch (error) {
    // HTTP responses were already recorded above before the error was thrown.
    // Only record here for transport/timeout failures that never produced
    // an HTTP status.
    if (recordMetric && !Number(error?.status || 0)) {
      metrics.push({
        label,
        method,
        route,
        status: 0,
        ok: false,
        durationMs: performance.now() - started,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function authenticatedSessions() {
  const sessions = BUSINESSES.map((b) => new Session(b));
  for (const s of sessions) {
    await s.login();
    const mine = await s.request("GET", "/api/businesses/mine", { label: `business-mine:${s.business.key}` });
    const mineId = String(getDeep(mine.body, ["data._id", "business._id", "data.business._id", "_id"]) || "");
    if (mineId && mineId !== s.business.id) {
      throw new Error(`Auth mismatch: ${s.business.name} expected ${s.business.id} but /businesses/mine returned ${mineId}`);
    }
  }
  return sessions;
}

async function preflight() {
  console.log("\n== PREFLIGHT ==");
  await rawRequest("GET", "/", { label: "api-root" });
  const sessions = await authenticatedSessions();
  for (const s of sessions) {
    await Promise.all([
      s.request("GET", "/api/auth/me", { label: `auth-me:${s.business.key}` }),
      s.request("GET", "/api/dashboard", { label: `dashboard:${s.business.key}` }),
      s.request("GET", "/api/leads", { label: `leads:${s.business.key}` }),
      s.request("GET", "/api/conversations", { label: `conversations:${s.business.key}` }),
      s.request("GET", "/api/calls", { label: `calls:${s.business.key}` }),
      s.request("GET", "/api/appointments", { label: `appointments:${s.business.key}` }),
      s.request("GET", "/api/marketing-sources", { label: `marketing:${s.business.key}` }),
      s.request("GET", "/api/business-configuration/bootstrap", { label: `config-bootstrap:${s.business.key}` }),
    ]);
  }
  console.log("Preflight passed for both businesses.");
  return sessions;
}

const SERVICES = [
  "water heater leaking",
  "clogged kitchen drain",
  "toilet overflowing",
  "low water pressure",
  "burst pipe in crawlspace",
  "garbage disposal not draining",
];

async function syntheticFlow(session, index, businessIndex) {
  const b = session.business;
  const phone = fakeCustomerPhone(index, businessIndex);
  const serviceNeeded = SERVICES[index % SERVICES.length];
  const urgency = ["low", "medium", "high", "emergency"][index % 4];
  const customerName = `Load Test ${b.key} ${index}`;
  const address = `${100 + (index % 800)} Test Fixture Ave, ${b.key === "atlanta" ? "Atlanta, GA 30303" : "Birmingham, AL 35203"}`;
  const preferredAppointmentTime = index % 2 ? "tomorrow around 10 AM" : "the next available afternoon";
  const providerCallId = `CA${crypto.createHash("md5").update(`${cfg.runTag}:${b.id}:${index}`).digest("hex")}`;

  const leadRes = await session.request("POST", "/api/leads", {
    label: `create-lead:${b.key}`,
    json: {
      customerName,
      phone,
      serviceNeeded,
      urgency,
      address,
      preferredAppointmentTime,
      leadQualityScore: 45 + (index % 50),
      estimatedValue: 150 + (index % 20) * 75,
      status: "new",
      source: "missed_call",
      summary: `[${cfg.runTag}] synthetic authorized load test lead`,
      notes: "Generated by callbackiq-real-activity-load.mjs",
    },
  });
  const leadId = getId(leadRes.body, ["data.lead._id"]);
  if (!leadId) throw new Error(`Could not extract lead ID for ${b.key} flow ${index}`);

  const convRes = await session.request("POST", "/api/conversations", {
    label: `create-conversation:${b.key}`,
    json: {
      business: b.id,
      lead: leadId,
      customerPhone: phone,
      customerName,
      status: "open",
      aiEnabled: true,
      humanTakeover: false,
      lastMessage: `I need help with a ${serviceNeeded}. ${preferredAppointmentTime}.`,
      lastMessageAt: new Date().toISOString(),
    },
  });
  const conversationId = getId(convRes.body, ["data.conversation._id"]);
  if (!conversationId) throw new Error(`Could not extract conversation ID for ${b.key} flow ${index}`);

  const messageBody = `My ${serviceNeeded} started today. Address is ${address}. Can someone come ${preferredAppointmentTime}?`;
  /*
   * /api/messages is the owner manual outbound-SMS endpoint and can invoke
   * Twilio. Safe synthetic load mode intentionally does not call it.
   * Inbound SMS is exercised separately by the gated webhook/provider modes.
   */

  const callRes = await session.request("POST", "/api/calls", {
    label: `create-call:${b.key}`,
    json: {
      business: b.id,
      lead: leadId,
      conversation: conversationId,
      from: phone,
      to: b.phone,
      direction: "inbound",
      status: index % 7 === 0 ? "busy" : "missed",
      durationSeconds: 0,
      provider: "system",
      providerCallId,
      missedCallTextSent: true,
      recovered: false,
      notes: `[${cfg.runTag}] synthetic load-test missed call`,
    },
  });

  created.push({
    business: b.key,
    phone,
    leadId,
    conversationId,
    messageId: null,
    callId: getId(callRes.body),
    providerCallId,
  });

  // Read-after-write validation exercises UI-facing query paths and catches
  // tenant-scoping/index/serialization regressions.
  await Promise.all([
    session.request("GET", `/api/leads/${leadId}`, { label: `read-lead:${b.key}` }),
    session.request("GET", `/api/conversations/${conversationId}`, { label: `read-conversation:${b.key}` }),
    session.request("GET", `/api/messages/conversation/${conversationId}`, { label: `read-messages:${b.key}` }),
    session.request("GET", "/api/dashboard", { label: `dashboard-refresh:${b.key}` }),
  ]);

  return { leadId, conversationId, phone, messageBody };
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const results = [];
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error: error.message };
        failures.push({ phase: "load", index: i, error: error.message });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function syntheticLoad(sessions) {
  if (!cfg.allowWrites) {
    throw new Error("Synthetic load writes are disabled. Set ALLOW_SYNTHETIC_WRITES=yes after pointing at an authorized test/staging environment.");
  }
  console.log(`\n== SYNTHETIC APP LOAD: ${cfg.flowsPerBusiness} flows/business, concurrency ${cfg.concurrency} ==`);
  const jobs = [];
  sessions.forEach((session, businessIndex) => {
    for (let i = 0; i < cfg.flowsPerBusiness; i++) jobs.push({ session, i, businessIndex });
  });
  const started = performance.now();
  const results = await runPool(jobs, cfg.concurrency, (job) => syntheticFlow(job.session, job.i, job.businessIndex));
  const elapsed = performance.now() - started;
  const passed = results.filter((r) => r?.ok).length;
  console.log(`Synthetic flows: ${passed}/${jobs.length} passed in ${(elapsed / 1000).toFixed(2)}s (${(jobs.length / (elapsed / 1000)).toFixed(2)} flows/s).`);

  // Small AI sample: the high-volume workload intentionally does NOT hammer
  // the OpenAI API. This tests integration correctness without making AI spend
  // proportional to LOAD_FLOWS_PER_BUSINESS.
  if (cfg.aiSamplesPerBusiness > 0 && cfg.allowProviderSideEffects) {
    for (const session of sessions) {
      const samples = created.filter((c) => c.business === session.business.key).slice(0, cfg.aiSamplesPerBusiness);
      for (const sample of samples) {
        await session.request("POST", "/api/ai/qualify-lead", {
          label: `ai-qualify:${session.business.key}`,
          json: {
            leadId: sample.leadId,
            messageBody: `Emergency-ish plumbing request at ${sample.phone}: leaking water heater, address already provided, customer wants tomorrow around 10 AM and wants a rough price estimate.`,
          },
        }).catch((error) => failures.push({ phase: "ai", business: session.business.key, error: error.message }));
      }
    }
  }

  for (const session of sessions) {
    await Promise.all([
      session.request("GET", "/api/dashboard", { label: `postload-dashboard:${session.business.key}` }),
      session.request("GET", "/api/leads", { label: `postload-leads:${session.business.key}` }),
      session.request("GET", "/api/conversations", { label: `postload-conversations:${session.business.key}` }),
      session.request("GET", "/api/calls", { label: `postload-calls:${session.business.key}` }),
      session.request("GET", "/api/appointments", { label: `postload-appointments:${session.business.key}` }),
      session.request("GET", "/api/marketing-sources", { label: `postload-attribution:${session.business.key}` }),
    ]);
  }
}

async function appointmentSmoke(session) {
  const b = session.business;
  const servicesRes = await session.request("GET", "/api/business-configuration/services", { label: `services:${b.key}` });
  const body = responseData(servicesRes.body);
  const services = Array.isArray(body) ? body : (body?.services || servicesRes.body?.services || []);
  const service = services.find((s) => s?.isActive !== false) || services[0];
  if (!service?._id) {
    failures.push({ phase: "appointment", business: b.key, error: "No service offering configured; appointment create skipped." });
    return;
  }

  const now = new Date();
  const startDate = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 8 * 24 * 3600_000).toISOString().slice(0, 10);
  const q = new URLSearchParams({
    businessId: b.id,
    serviceOfferingId: String(service._id),
    startDate,
    endDate,
    ...(b.postalCode ? { postalCode: b.postalCode } : {}),
  });
  const availability = await session.request("GET", `/api/availability?${q}`, { label: `availability:${b.key}` });
  const slots = availability.body?.slots || availability.body?.data?.slots || [];
  const slot = slots.find((s) => s?.startAt) || slots[0];
  if (!slot?.startAt) {
    failures.push({ phase: "appointment", business: b.key, error: "No available appointment slot in next 8 days; create skipped." });
    return;
  }

  if (!cfg.allowWrites) return;
  const sample = created.find((c) => c.business === b.key);
  const phone = sample?.phone || fakeCustomerPhone(999, BUSINESSES.indexOf(b));
  const idempotencyKey = `${cfg.runTag}:appointment:${b.id}`;
  const createRes = await session.request("POST", "/api/appointments", {
    label: `appointment-hold:${b.key}`,
    headers: { "Idempotency-Key": idempotencyKey },
    json: {
      businessId: b.id,
      serviceOfferingId: String(service._id),
      customerName: `Appointment Smoke ${b.key}`,
      customerPhone: phone,
      address: {
        street: "123 Test Fixture Ave",
        city: b.key === "atlanta" ? "Atlanta" : "Birmingham",
        state: b.key === "atlanta" ? "GA" : "AL",
        postalCode: b.postalCode,
      },
      startAt: slot.startAt,
      ...(slot.endAt ? { endAt: slot.endAt } : {}),
      timezone: b.timezone,
      lead: sample?.leadId || null,
      conversation: sample?.conversationId || null,
      source: "manual",
      bookedBy: "staff",
      confirm: false,
      requiresBusinessApproval: true,
      notes: `[${cfg.runTag}] appointment hold smoke`,
    },
    accepted: [201, 202],
  });
  const appointmentId = getId(createRes.body);
  if (!appointmentId) throw new Error(`Could not extract appointment ID for ${b.key}`);
  created.push({ business: b.key, appointmentId });
  await session.request("GET", `/api/appointments/${appointmentId}?businessId=${encodeURIComponent(b.id)}`, { label: `appointment-read:${b.key}` });

  if (cfg.allowProviderSideEffects) {
    await session.request("POST", `/api/appointments/${appointmentId}/confirm`, {
      label: `appointment-confirm:${b.key}`,
      json: { businessId: b.id },
    });
    // Confirm may schedule customer SMS/calendar/reminders according to current
    // business integration settings; this is why it is explicitly gated.
  }
}

async function twilioSignature(url, params) {
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!token) throw new Error("TWILIO_AUTH_TOKEN is required for signed webhook simulation.");
  const mod = await import("twilio");
  const twilio = mod.default || mod;
  if (typeof twilio.getExpectedTwilioSignature !== "function") {
    throw new Error("Installed twilio package does not expose getExpectedTwilioSignature().");
  }
  return twilio.getExpectedTwilioSignature(token, url, params);
}

async function signedWebhook(pathname, params, label) {
  const signatureUrl = `${cfg.webhookSignatureBase}${pathname}`;
  const signature = await twilioSignature(signatureUrl, params);
  return rawRequest("POST", pathname, {
    label,
    form: params,
    headers: { "X-Twilio-Signature": signature },
  });
}

async function providerWebhookSmoke(sessions) {
  if (!cfg.allowProviderSideEffects) {
    throw new Error("Provider webhook smoke can invoke real SMS/AI/voice side effects. Set ALLOW_PROVIDER_SIDE_EFFECTS=yes to run the capped provider path.");
  }
  console.log(`\n== SIGNED TWILIO WEBHOOK SMOKE (capped ${cfg.providerWebhookFlowsPerBusiness}/business) ==`);
  let seq = 0;
  for (const session of sessions) {
    const b = session.business;
    for (let i = 0; i < cfg.providerWebhookFlowsPerBusiness; i++) {
      const phone = fakeCustomerPhone(7000 + seq++, BUSINESSES.indexOf(b));
      const callSid = id32("CA");
      await signedWebhook("/api/twilio/voice", {
        From: phone,
        Caller: phone,
        To: b.phone,
        Called: b.phone,
        CallSid: callSid,
        CallStatus: "ringing",
        Direction: "inbound",
      }, `twilio-voice:${b.key}`);

      await signedWebhook("/api/twilio/status", {
        From: phone,
        To: b.phone,
        CallSid: callSid,
        CallStatus: "no-answer",
        CallDuration: "0",
        Direction: "inbound",
      }, `twilio-status:${b.key}`);

      // One realistic inbound reply exercises SMS routing, AI orchestration,
      // qualification, booking language, and outbound reply behavior.
      const messageSid = id32("SM");
      await signedWebhook("/api/twilio/sms", {
        From: phone,
        To: b.phone,
        Body: i % 2 === 0
          ? "My water heater is leaking badly. I am at 123 Test Fixture Ave. Can someone come tomorrow around 10 AM? What might this roughly cost?"
          : "My drain is clogged. I can only do 11 PM tonight. Are you open then, and if not what times are available?",
        MessageSid: messageSid,
        SmsSid: messageSid,
        SmsStatus: "received",
        NumMedia: "0",
      }, `twilio-sms:${b.key}`);
    }
    await Promise.all([
      session.request("GET", "/api/calls", { label: `verify-webhook-calls:${b.key}` }),
      session.request("GET", "/api/leads", { label: `verify-webhook-leads:${b.key}` }),
      session.request("GET", "/api/conversations", { label: `verify-webhook-conversations:${b.key}` }),
      session.request("GET", "/api/dashboard", { label: `verify-webhook-dashboard:${b.key}` }),
    ]);
  }
}


function normalizePhone(value) {
  return String(value || "").replace(/[^+\d]/g, "");
}

function unwrapList(payload) {
  const body = responseData(payload);
  if (Array.isArray(body)) return body;
  for (const key of ["items", "results", "sources", "marketingSources", "calls", "data"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

async function discoverModel(modelName) {
  const mongooseMod = await import("mongoose");
  const mongoose = mongooseMod.default || mongooseMod;
  if (mongoose.models?.[modelName]) return mongoose.models[modelName];
  const roots = [path.join(API_ROOT, "src", "models"), path.join(API_ROOT, "src", "model")];
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:js|mjs|cjs)$/i.test(entry.name)) files.push(full);
    }
  }
  for (const root of roots) await walk(root);
  const needle = modelName.toLowerCase();
  const likely = [];
  const rest = [];
  for (const file of files) {
    let text = "";
    try { text = (await fs.readFile(file, "utf8")).toLowerCase(); } catch {}
    (text.includes(needle) || path.basename(file).toLowerCase().includes(needle) ? likely : rest).push(file);
  }
  for (const file of [...likely, ...rest]) {
    try {
      const mod = await import(pathToFileURL(file).href);
      for (const candidate of [mod.default, ...Object.values(mod)]) {
        if (candidate?.modelName === modelName) return candidate;
      }
      if (mongoose.models?.[modelName]) return mongoose.models[modelName];
    } catch {}
  }
  throw new Error(`Could not discover Mongoose model ${modelName} under ${path.relative(process.cwd(), API_ROOT)}/src/models.`);
}


async function discoverExportedFunction(functionName) {
  const root = path.join(API_ROOT, "src");
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:js|mjs|cjs)$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(root);
  for (const file of files) {
    let text;
    try { text = await fs.readFile(file, "utf8"); } catch { continue; }
    if (!text.includes(functionName)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod?.[functionName] === "function") return mod[functionName];
      if (typeof mod?.default?.[functionName] === "function") return mod.default[functionName].bind(mod.default);
    } catch {}
  }
  return null;
}

function schemaPathType(Model, pathName) {
  const p = Model.schema?.path(pathName);
  return String(p?.instance || p?.constructor?.name || "").toLowerCase();
}

function existingPath(Model, candidates) {
  return candidates.find((name) => Model.schema?.path(name));
}

function setIfPath(Model, doc, candidates, value) {
  const key = existingPath(Model, candidates);
  if (key && value !== undefined) doc[key] = value;
  return key;
}

function enumValue(Model, pathName, preferred, fallback) {
  const p = Model.schema?.path(pathName);
  const values = p?.enumValues || p?.options?.enum || [];
  if (!values?.length) return fallback;
  for (const wanted of preferred) {
    const hit = values.find((v) => String(v).toLowerCase() === String(wanted).toLowerCase());
    if (hit !== undefined) return hit;
  }
  return values[0];
}

function normalizeFixtureKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function requiredFixtureValue(Model, name, schemaPath, context) {
  const lower = name.toLowerCase();
  const type = String(schemaPath?.instance || "").toLowerCase();

  if (lower.includes("business")) return context.business.id;
  if (lower.includes("owner")) return context.business.ownerId;
  if (lower.includes("marketingsource") || lower === "sourceid") return context.sourceId;
  if ((lower.includes("trackingnumber") || lower.includes("phone")) && type === "objectid") return context.trackingId;

  // Normalized/unique key fields are common on attribution models. Derive them
  // deterministically from the fixture value instead of inventing unrelated data.
  if (lower === "namekey" || lower.endsWith("namekey")) return normalizeFixtureKey(context.sourceName);
  if (lower.includes("numberkey") || lower.includes("phonekey") || lower.includes("e164key")) {
    return normalizePhone(context.fakeNumber) || String(context.fakeNumber || "").replace(/\D/g, "");
  }
  if (lower.endsWith("key") && lower.includes("source")) return normalizeFixtureKey(context.sourceName);

  if (lower.includes("number") || lower.includes("phone")) return context.fakeNumber;
  if (lower.includes("name")) return context.sourceName;
  if (lower.includes("status")) return enumValue(Model, name, ["active", "enabled", "ready"], "active");

  // Never synthesize an arbitrary string for a schema enum. Attribution models
  // use enums for fields such as TrackingNumber.kind; use a semantically
  // appropriate allowed value when possible, otherwise the model's first
  // declared value. This keeps fixtures schema-valid as the production model
  // evolves without bypassing Mongoose validation.
  const allowedEnumValues = schemaPath?.enumValues || schemaPath?.options?.enum || [];
  if (allowedEnumValues?.length) {
    const preferred = lower.includes("kind") || lower.includes("type") || lower.includes("purpose")
      ? ["tracking", "attribution", "marketing", "campaign", "source", "secondary", "dedicated", "inbound"]
      : ["active", "enabled", "ready", "tracking", "attribution", "other"];
    return enumValue(Model, name, preferred, allowedEnumValues[0]);
  }

  if (type === "string") return `${cfg.runTag}-${name}`;
  if (type === "boolean") return true;
  if (type === "number") return 0;
  if (type === "date") return new Date();
  return undefined;
}

function setGenericRequiredFields(Model, doc, context) {
  for (const [name, schemaPath] of Object.entries(Model.schema?.paths || {})) {
    if (["_id", "__v", "createdAt", "updatedAt"].includes(name)) continue;
    if (doc[name] !== undefined || schemaPath?.options?.required !== true) continue;
    const value = requiredFixtureValue(Model, name, schemaPath, context);
    if (value !== undefined && value !== null && value !== "") doc[name] = value;
  }
}

function applyAttributionFields(Model, doc, { sourceId, sourceName, trackingId, fakeNumber }) {
  for (const [name, schemaPath] of Object.entries(Model.schema?.paths || {})) {
    const lower = name.toLowerCase();
    const type = String(schemaPath.instance || "").toLowerCase();
    if (lower.includes("marketingsource")) {
      doc[name] = type === "objectid" ? sourceId : (lower.includes("name") ? sourceName : String(sourceId));
    } else if (lower.includes("trackingnumber")) {
      if (type === "objectid") doc[name] = trackingId;
      else if (lower.includes("sid")) doc[name] = id32("PN");
      else doc[name] = fakeNumber;
    } else if (lower === "source" && Model.modelName === "CallLog") {
      const values = schemaPath?.enumValues || [];
      if (!values.length || values.includes("missed_call")) doc[name] = "missed_call";
    }
  }
}

function attributionSnapshot(Model, doc) {
  const out = {};
  for (const name of Object.keys(Model.schema?.paths || {})) {
    const lower = name.toLowerCase();
    if (lower.includes("marketingsource") || lower.includes("trackingnumber") || lower.startsWith("attribution.")) {
      const value = doc?.get ? doc.get(name) : getDeep(doc, [name]);
      if (value !== undefined && value !== null) out[name] = String(value?._id || value);
    }
  }
  return out;
}

function snapshotHasAttribution(snapshot, sourceId, trackingId, fakeNumber) {
  const values = Object.values(snapshot).map((v) => String(v));
  const sourceOk = values.some((v) => v === String(sourceId));
  const trackingOk = values.some((v) => v === String(trackingId) || normalizePhone(v) === normalizePhone(fakeNumber));
  return { sourceOk, trackingOk };
}

async function createMarketingFixture(MarketingSource, business, sourceName, sourceKind, fixtureIds) {
  const doc = {};
  setIfPath(MarketingSource, doc, ["business", "businessId"], business.id);
  setIfPath(MarketingSource, doc, ["owner", "ownerId"], business.ownerId);
  setIfPath(MarketingSource, doc, ["name", "label", "displayName"], sourceName);
  setIfPath(MarketingSource, doc, ["nameKey"], normalizeFixtureKey(sourceName));
  const typePath = existingPath(MarketingSource, ["type", "sourceType", "channel", "kind", "category"]);
  if (typePath) doc[typePath] = enumValue(MarketingSource, typePath, [sourceKind, "google_ads", "google", "paid_search", "other"], sourceKind);
  const statusPath = existingPath(MarketingSource, ["status", "state"]);
  if (statusPath) doc[statusPath] = enumValue(MarketingSource, statusPath, ["active", "enabled"], "active");
  setIfPath(MarketingSource, doc, ["isActive", "active", "enabled"], true);
  setIfPath(MarketingSource, doc, ["description", "notes"], `[${cfg.runTag}] synthetic attribution fixture`);
  setGenericRequiredFields(MarketingSource, doc, { business, sourceName, sourceId: null, trackingId: null, fakeNumber: "" });
  const source = await MarketingSource.create(doc);
  fixtureIds.sources.push(source._id);
  return source;
}

async function createTrackingFixture(TrackingNumber, business, source, fakeNumber, fixtureIds) {
  const sourceName = String(source.name || source.label || `${cfg.runTag}-source`);
  const doc = {};
  setIfPath(TrackingNumber, doc, ["business", "businessId"], business.id);
  setIfPath(TrackingNumber, doc, ["owner", "ownerId"], business.ownerId);
  setIfPath(TrackingNumber, doc, ["marketingSource", "marketingSourceId", "source", "sourceId"], source._id);
  setIfPath(TrackingNumber, doc, ["phoneNumber", "number", "trackingNumber", "phone", "e164"], fakeNumber);
  setIfPath(TrackingNumber, doc, ["twilioSid", "phoneNumberSid", "incomingPhoneNumberSid", "sid"], id32("PN"));
  setIfPath(TrackingNumber, doc, ["forwardingNumber", "forwardTo", "destinationNumber", "destination"], business.forwardingPhone);
  setIfPath(TrackingNumber, doc, ["friendlyName", "label", "name"], `${sourceName} Tracking`);
  const statusPath = existingPath(TrackingNumber, ["status", "state"]);
  if (statusPath) doc[statusPath] = enumValue(TrackingNumber, statusPath, ["active", "assigned", "ready", "enabled"], "active");
  const kindPath = existingPath(TrackingNumber, ["kind", "type", "purpose"]);
  if (kindPath && doc[kindPath] === undefined) {
    doc[kindPath] = enumValue(TrackingNumber, kindPath, ["tracking", "attribution", "marketing", "campaign", "source", "secondary", "dedicated", "inbound"], undefined);
  }
  setIfPath(TrackingNumber, doc, ["isActive", "active", "enabled"], true);
  setGenericRequiredFields(TrackingNumber, doc, { business, sourceName, sourceId: source._id, trackingId: null, fakeNumber });
  const tracking = await TrackingNumber.create(doc);
  fixtureIds.tracking.push(tracking._id);
  return tracking;
}

async function createAttributedCallFixture(CallLog, business, source, tracking, fakeNumber, callerPhone, fixtureIds) {
  const providerCallId = id32("CA");
  const doc = {};
  setIfPath(CallLog, doc, ["business", "businessId"], business.id);
  setIfPath(CallLog, doc, ["from", "fromNumber", "callerPhone"], callerPhone);
  setIfPath(CallLog, doc, ["to", "toNumber", "calledNumber"], fakeNumber);
  setIfPath(CallLog, doc, ["direction"], enumValue(CallLog, "direction", ["inbound"], "inbound"));
  setIfPath(CallLog, doc, ["status"], enumValue(CallLog, "status", ["answered", "completed", "missed"], "answered"));
  setIfPath(CallLog, doc, ["durationSeconds", "duration"], 12);
  setIfPath(CallLog, doc, ["provider"], enumValue(CallLog, "provider", ["twilio", "system"], "system"));
  setIfPath(CallLog, doc, ["providerCallId", "callSid", "twilioCallSid"], providerCallId);
  setIfPath(CallLog, doc, ["notes"], `[${cfg.runTag}] attributed synthetic call`);
  applyAttributionFields(CallLog, doc, { sourceId: source._id, sourceName: String(source.name || "Synthetic Source"), trackingId: tracking._id, fakeNumber });
  setGenericRequiredFields(CallLog, doc, { business, sourceName: String(source.name || "Synthetic Source"), sourceId: source._id, trackingId: tracking._id, fakeNumber });
  const call = await CallLog.create(doc);
  fixtureIds.calls.push(call._id);
  return { call, providerCallId };
}

async function findApiItemByMarker(session, route, markerKeys, markerValue, label) {
  const res = await session.request("GET", route, { label });
  const items = unwrapList(res.body);
  return items.find((item) => markerKeys.some((key) => String(getDeep(item, [key]) || "") === String(markerValue)));
}

async function attributionAppointment(session, sample, models, fixtureIds) {
  const { Appointment } = models;
  const b = session.business;
  const servicesRes = await session.request("GET", "/api/business-configuration/services", { label: `attrib-services:${b.key}` });
  const servicesBody = responseData(servicesRes.body);
  const services = Array.isArray(servicesBody) ? servicesBody : (servicesBody?.services || servicesRes.body?.services || []);
  const service = services.find((s) => s?.isActive !== false) || services[0];
  if (!service?._id) return { skipped: "No active service offering configured." };
  const now = new Date();
  const startDate = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 8 * 24 * 3600_000).toISOString().slice(0, 10);
  const q = new URLSearchParams({ businessId: b.id, serviceOfferingId: String(service._id), startDate, endDate, ...(b.postalCode ? { postalCode: b.postalCode } : {}) });
  const availability = await session.request("GET", `/api/availability?${q}`, { label: `attrib-availability:${b.key}` });
  const slots = availability.body?.slots || availability.body?.data?.slots || [];
  const slot = slots.find((s) => s?.startAt) || slots[0];
  if (!slot?.startAt) return { skipped: "No available slot in next 8 days." };
  const res = await session.request("POST", "/api/appointments", {
    label: `attrib-appointment-hold:${b.key}`,
    headers: { "Idempotency-Key": `${cfg.runTag}:attrib:${b.id}:${sample.fakeNumber}` },
    accepted: [201, 202],
    json: {
      businessId: b.id,
      serviceOfferingId: String(service._id),
      customerName: sample.customerName,
      customerPhone: sample.callerPhone,
      address: { street: "456 Attribution Fixture Ave", city: b.key === "atlanta" ? "Atlanta" : "Birmingham", state: b.key === "atlanta" ? "GA" : "AL", postalCode: b.postalCode },
      startAt: slot.startAt,
      ...(slot.endAt ? { endAt: slot.endAt } : {}),
      timezone: b.timezone,
      lead: sample.leadId,
      conversation: sample.conversationId,
      source: "manual",
      bookedBy: "staff",
      confirm: false,
      requiresBusinessApproval: true,
      notes: `[${cfg.runTag}] attributed appointment hold`,
    },
  });
  const appointmentId = getId(res.body);
  if (!appointmentId) return { skipped: "Appointment API did not return an ID." };
  fixtureIds.appointments.push(appointmentId);
  const appointment = await Appointment.findById(appointmentId).lean();
  const snap = attributionSnapshot(Appointment, appointment || {});
  return { appointmentId, snapshot: snap, ...snapshotHasAttribution(snap, sample.sourceId, sample.trackingId, sample.fakeNumber) };
}

async function attributionSmoke(sessions) {
  if (!cfg.allowWrites || !cfg.allowAttributionFixtures) {
    throw new Error("Attribution fixtures require ALLOW_SYNTHETIC_WRITES=yes and ALLOW_ATTRIBUTION_FIXTURES=yes.");
  }
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!mongoUri) throw new Error("Attribution fixture mode requires MONGODB_URI or MONGO_URL for the same authorized database used by the API. The harness will not create fake tracking-number records through the real provisioning endpoint.");
  console.log(`\n== SYNTHETIC ATTRIBUTION: ${cfg.attributionNumbersPerBusiness} fake tracking numbers/business ==`);
  const mongooseMod = await import("mongoose");
  const mongoose = mongooseMod.default || mongooseMod;
  const connectedHere = mongoose.connection.readyState === 0;
  if (connectedHere) await mongoose.connect(mongoUri);
  const models = {
    MarketingSource: await discoverModel("MarketingSource"),
    TrackingNumber: await discoverModel("TrackingNumber"),
    CallLog: await discoverModel("CallLog"),
    Lead: await discoverModel("Lead"),
    Conversation: await discoverModel("Conversation"),
    Appointment: await discoverModel("Appointment"),
  };
  const resolveTwilioNumberContext = await discoverExportedFunction("resolveTwilioNumberContext");
  const fixtureIds = { sources: [], tracking: [], calls: [], leads: [], conversations: [], appointments: [] };
  const sourceKinds = ["google_ads", "local_services_ads", "facebook_ads", "organic_search", "direct", "other"];
  try {
    for (let bi = 0; bi < sessions.length; bi++) {
      const session = sessions[bi];
      const business = session.business;
      for (let i = 0; i < cfg.attributionNumbersPerBusiness; i++) {
        const fakeNumber = `+1${bi === 0 ? "212" : "213"}55501${String(10 + i).padStart(2, "0")}`;
        const sourceKind = sourceKinds[i % sourceKinds.length];
        const sourceName = `${sourceKind.replaceAll("_", " ")} - ${cfg.runTag} - ${business.key} - ${i + 1}`;
        const source = await createMarketingFixture(models.MarketingSource, business, sourceName, sourceKind, fixtureIds);
        const tracking = await createTrackingFixture(models.TrackingNumber, business, source, fakeNumber, fixtureIds);
        let directResolver = { available: Boolean(resolveTwilioNumberContext), ok: null, error: undefined };
        if (resolveTwilioNumberContext) {
          try {
            const resolved = await resolveTwilioNumberContext(fakeNumber);
            const resolvedBusinessId = String(getDeep(resolved, ["business._id", "business.id", "businessId", "business", "context.business._id"]) || "");
            const resolvedTrackingId = String(getDeep(resolved, ["trackingNumber._id", "trackingNumber.id", "trackingNumberId", "context.trackingNumber._id"]) || "");
            const resolvedSourceId = String(getDeep(resolved, ["marketingSource._id", "marketingSource.id", "marketingSourceId", "source._id", "sourceId", "context.marketingSource._id"]) || "");
            directResolver = { available: true, ok: resolvedBusinessId === business.id && (!resolvedTrackingId || resolvedTrackingId === String(tracking._id)) && (!resolvedSourceId || resolvedSourceId === String(source._id)), resolvedBusinessId, resolvedTrackingId, resolvedSourceId };
          } catch (error) {
            directResolver = { available: true, ok: false, error: error.message };
          }
        }
        const attributionAreaCode = bi === 0 ? "907" : "808";
        const callerPhone =
          `+1${attributionAreaCode}555${String(160 + i).padStart(4, "0")}`;
        const { call, providerCallId } = await createAttributedCallFixture(models.CallLog, business, source, tracking, fakeNumber, callerPhone, fixtureIds);

        const sourceList = await session.request("GET", "/api/marketing-sources", { label: `attrib-source-list:${business.key}` });
        const sourceVisible = unwrapList(sourceList.body).some((item) => String(item?._id || item?.id) === String(source._id));
        const callVisible = Boolean(await findApiItemByMarker(session, "/api/calls", ["providerCallId", "callSid", "twilioCallSid"], providerCallId, `attrib-call-list:${business.key}`));

        let webhookOk = false;
        let webhookError = "";
        try {
          const callSid = id32("CA");
          const probe = await signedWebhook("/api/twilio/status", { From: callerPhone, To: fakeNumber, CallSid: callSid, CallStatus: "queued", Direction: "inbound" }, `attrib-signed-status:${business.key}`);
          webhookOk = probe.status >= 200 && probe.status < 300;
        } catch (error) {
          webhookError = error.message;
        }

        const customerName = `Attribution Test ${business.key} ${i + 1}`;
        const leadRes = await session.request("POST", "/api/leads", {
          label: `attrib-create-lead:${business.key}`,
          json: { customerName, phone: callerPhone, serviceNeeded: "attribution test plumbing call", urgency: "medium", status: "new", source: "missed_call", summary: `[${cfg.runTag}] attribution propagation lead`, notes: `Tracking fixture ${fakeNumber}` },
        });
        const leadId = getId(leadRes.body, ["data.lead._id"]);
        if (!leadId) throw new Error(`Could not extract attribution lead ID for ${business.key}`);
        fixtureIds.leads.push(leadId);
        const convRes = await session.request("POST", "/api/conversations", {
          label: `attrib-create-conversation:${business.key}`,
          json: { business: business.id, lead: leadId, customerPhone: callerPhone, customerName, status: "open", aiEnabled: true, humanTakeover: false, lastMessage: "Attribution load-test conversation", lastMessageAt: new Date().toISOString() },
        });
        const conversationId = getId(convRes.body, ["data.conversation._id"]);
        if (!conversationId) throw new Error(`Could not extract attribution conversation ID for ${business.key}`);
        fixtureIds.conversations.push(conversationId);

        await models.CallLog.updateOne({ _id: call._id }, { $set: { ...(models.CallLog.schema.path("lead") ? { lead: leadId } : {}), ...(models.CallLog.schema.path("conversation") ? { conversation: conversationId } : {}) } });
        let lead = await models.Lead.findById(leadId).lean();
        let conversation = await models.Conversation.findById(conversationId).lean();
        const callFresh = await models.CallLog.findById(call._id).lean();
        const leadSnapAuto = attributionSnapshot(models.Lead, lead || {});
        const convSnapAuto = attributionSnapshot(models.Conversation, conversation || {});
        const callSnap = attributionSnapshot(models.CallLog, callFresh || {});
        const leadAutoAttr = snapshotHasAttribution(leadSnapAuto, source._id, tracking._id, fakeNumber);
        const convAutoAttr = snapshotHasAttribution(convSnapAuto, source._id, tracking._id, fakeNumber);
        const callAttr = snapshotHasAttribution(callSnap, source._id, tracking._id, fakeNumber);

        const leadAttributionUpdate = {};
        applyAttributionFields(models.Lead, leadAttributionUpdate, { sourceId: source._id, sourceName, trackingId: tracking._id, fakeNumber });
        if (Object.keys(leadAttributionUpdate).length && (!leadAutoAttr.sourceOk || !leadAutoAttr.trackingOk)) {
          await models.Lead.updateOne({ _id: leadId }, { $set: leadAttributionUpdate });
          lead = await models.Lead.findById(leadId).lean();
        }
        const conversationAttributionUpdate = {};
        applyAttributionFields(models.Conversation, conversationAttributionUpdate, { sourceId: source._id, sourceName, trackingId: tracking._id, fakeNumber });
        if (Object.keys(conversationAttributionUpdate).length && (!convAutoAttr.sourceOk || !convAutoAttr.trackingOk)) {
          await models.Conversation.updateOne({ _id: conversationId }, { $set: conversationAttributionUpdate });
          conversation = await models.Conversation.findById(conversationId).lean();
        }
        const leadSnap = attributionSnapshot(models.Lead, lead || {});
        const convSnap = attributionSnapshot(models.Conversation, conversation || {});
        const leadAttr = snapshotHasAttribution(leadSnap, source._id, tracking._id, fakeNumber);
        const convAttr = snapshotHasAttribution(convSnap, source._id, tracking._id, fakeNumber);
        await Promise.all([
          session.request("GET", `/api/leads/${leadId}`, { label: `attrib-read-lead:${business.key}` }),
          session.request("GET", `/api/conversations/${conversationId}`, { label: `attrib-read-conversation:${business.key}` }),
        ]);

        let crossTenantLeak = false;
        const otherSession = sessions[(bi + 1) % sessions.length];
        if (otherSession !== session) {
          const otherCalls = await otherSession.request("GET", "/api/calls", { label: `attrib-isolation-calls:${business.key}` });
          const otherSources = await otherSession.request("GET", "/api/marketing-sources", { label: `attrib-isolation-sources:${business.key}` });
          crossTenantLeak = unwrapList(otherCalls.body).some((item) => String(getDeep(item, ["providerCallId", "callSid", "twilioCallSid"]) || "") === providerCallId)
            || unwrapList(otherSources.body).some((item) => String(item?._id || item?.id) === String(source._id));
        }

        let appointmentResult = { skipped: "Only the first attribution source per business gets an appointment inheritance check." };
        if (i === 0) {
          appointmentResult = await attributionAppointment(session, { customerName, callerPhone, leadId, conversationId, sourceId: source._id, trackingId: tracking._id, fakeNumber }, models, fixtureIds);
        }
        const result = {
          business: business.name,
          fakeNumber,
          marketingSourceId: String(source._id),
          trackingNumberId: String(tracking._id),
          callLogId: String(call._id),
          leadId,
          conversationId,
          sourceVisible,
          callVisible,
          signedWebhookRouting: webhookOk,
          signedWebhookError: webhookError || undefined,
          directResolver,
          callAttribution: callAttr,
          leadAutomaticPropagation: leadAutoAttr,
          conversationAutomaticPropagation: convAutoAttr,
          leadAttributionPersistence: leadAttr,
          conversationAttributionPersistence: convAttr,
          appointment: appointmentResult,
          crossTenantLeak,
        };
        attributionResults.push(result);
        const resolverPass = !directResolver.available || directResolver.ok === true;
        const appointmentPass = appointmentResult?.skipped || (appointmentResult.sourceOk && appointmentResult.trackingOk);
        const corePass = sourceVisible && callVisible && webhookOk && resolverPass && callAttr.sourceOk && callAttr.trackingOk && !crossTenantLeak && appointmentPass;
        console.log(`${corePass ? "✓" : "✗"} ${business.name}: ${fakeNumber} -> ${sourceName}`);
        if (!corePass) failures.push({ phase: "attribution", business: business.key, fakeNumber, error: `Core attribution verification failed: ${JSON.stringify(result)}` });
        if (cfg.strictAttributionPropagation && Object.keys(models.Lead.schema.paths).some((p) => p.toLowerCase().includes("marketingsource") || p.toLowerCase().includes("trackingnumber")) && (!leadAutoAttr.sourceOk || !leadAutoAttr.trackingOk)) {
          failures.push({ phase: "attribution-propagation", business: business.key, fakeNumber, entity: "lead", error: "STRICT_ATTRIBUTION_PROPAGATION=yes and automatic lead attribution was not observed on the generic authenticated lead-create path." });
        }
        if (cfg.strictAttributionPropagation && Object.keys(models.Conversation.schema.paths).some((p) => p.toLowerCase().includes("marketingsource") || p.toLowerCase().includes("trackingnumber")) && (!convAutoAttr.sourceOk || !convAutoAttr.trackingOk)) {
          failures.push({ phase: "attribution-propagation", business: business.key, fakeNumber, entity: "conversation", error: "STRICT_ATTRIBUTION_PROPAGATION=yes and automatic conversation attribution was not observed on the generic authenticated conversation-create path." });
        }
      }
    }
  } finally {
    if (!cfg.keepAttributionFixtures) {
      for (const [modelName, key] of [["Appointment", "appointments"], ["Conversation", "conversations"], ["Lead", "leads"], ["CallLog", "calls"], ["TrackingNumber", "tracking"], ["MarketingSource", "sources"]]) {
        const Model = models[modelName];
        const ids = fixtureIds[key].filter(Boolean);
        if (ids.length) await Model.deleteMany({ _id: { $in: ids } }).catch((error) => failures.push({ phase: "attribution-cleanup", model: modelName, error: error.message }));
      }
      console.log("Synthetic attribution fixtures cleaned up.");
    } else {
      console.log("KEEP_ATTRIBUTION_FIXTURES=yes: synthetic attribution records were intentionally retained.");
    }
    if (connectedHere) await mongoose.disconnect();
  }
}

async function liveCalls() {
  if (!cfg.allowLiveCalls) throw new Error("Set ALLOW_LIVE_CALLS=yes to place real calls. This mode is capped and billable.");
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const from = String(process.env.LIVE_CALLER_ID || "").trim();
  if (!accountSid || !authToken || !from) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and LIVE_CALLER_ID are required for live calls.");
  if (BUSINESSES.some((b) => b.phone === from)) throw new Error("LIVE_CALLER_ID must be a separate Twilio/verified caller ID, not either CallBackIQ business number.");

  const mod = await import("twilio");
  const twilio = mod.default || mod;
  const client = twilio(accountSid, authToken);
  const targets = Array.from({ length: cfg.maxLiveCallsTotal }, (_, i) => BUSINESSES[i % BUSINESSES.length]);
  console.log(`\n== LIVE PHONE SMOKE: ${targets.length} real calls total ==`);
  for (const b of targets) {
    const call = await client.calls.create({
      to: b.phone,
      from,
      // On an outbound test call, the called CallBackIQ number's normal inbound
      // voice webhook is still the path under test. Keep the originating leg
      // alive briefly and do not create any new phone-number resources.
      twiml: "<Response><Pause length=\"20\"/></Response>",
      statusCallback: process.env.LIVE_CALL_STATUS_CALLBACK || undefined,
      statusCallbackEvent: process.env.LIVE_CALL_STATUS_CALLBACK ? ["initiated", "ringing", "answered", "completed"] : undefined,
    });
    console.log(`Placed live call ${call.sid} -> ${b.name} (${b.phone})`);
  }
}

async function liveSms() {
  if (!cfg.allowLiveSms) throw new Error("Set ALLOW_LIVE_SMS=yes to send real SMS. This mode is capped and billable.");
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const from = String(process.env.LIVE_SMS_FROM || "").trim();
  if (!accountSid || !authToken || !from) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and LIVE_SMS_FROM are required for live SMS.");
  if (BUSINESSES.some((b) => b.phone === from)) throw new Error("LIVE_SMS_FROM should be a separate test/customer-capable Twilio number.");
  const mod = await import("twilio");
  const twilio = mod.default || mod;
  const client = twilio(accountSid, authToken);
  const scenarios = [
    "My water heater is leaking. I am at 123 Test Fixture Ave. Can you come tomorrow around 10 AM?",
    "Can you give me a rough estimate for a clogged main drain? I understand it is only an estimate.",
    "I can only do 11 PM tonight. If you are closed, what is your next available time?",
    "Thanks. Please have the business confirm the appointment before it is final.",
  ].slice(0, cfg.maxLiveSmsTotal);
  for (let i = 0; i < scenarios.length; i++) {
    const target = BUSINESSES[i % BUSINESSES.length];
    const msg = await client.messages.create({ from, to: target.phone, body: scenarios[i] });
    console.log(`Sent live SMS ${msg.sid} -> ${target.name}`);
  }
}

async function uiSmoke() {
  assertTargetAllowed(cfg.uiBase);
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("UI mode requires Playwright. Run: npm install --save-dev playwright && npx playwright install chromium");
  }
  console.log("\n== UI SMOKE ==");
  const key = "ATLANTA";
  const login = String(process.env[`LOGIN_${key}`] || "").trim();
  const password = String(process.env[`PASSWORD_${key}`] || "");
  if (!login || !password) throw new Error("UI smoke uses the Atlanta owner account. Set LOGIN_ATLANTA and PASSWORD_ATLANTA.");

  const browser = await chromium.launch({ headless: !yes("UI_HEADFUL") });
  const context = await browser.newContext();
  const page = await context.newPage();
  const uiErrors = [];
  let uiAuthenticated = false;

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;

    const message = msg.text();

    /*
     * The login screen performs an intentional session probe.
     * An unauthenticated /api/auth/me response is expected before login.
     * Do not classify the browser's generic 401 resource message as a
     * runtime failure until authentication has completed.
     */
    if (
      !uiAuthenticated &&
      /Failed to load resource: the server responded with a status of 401/i.test(
        message,
      )
    ) {
      return;
    }

    uiErrors.push(`console: ${message}`);
  });

  page.on("pageerror", (err) =>
    uiErrors.push(`pageerror: ${err.message}`)
  );

  page.on("response", (res) => {
    const status = res.status();

    if (status >= 500) {
      uiErrors.push(`HTTP ${status} ${res.url()}`);
      return;
    }

    /*
     * A 401/403 after a successful login is meaningful and must fail
     * the smoke test.
     */
    if (uiAuthenticated && (status === 401 || status === 403)) {
      uiErrors.push(`HTTP ${status} ${res.url()}`);
    }
  });

  await page.goto(`${cfg.uiBase}/login`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.locator("#login").fill(login);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === "/dashboard" ||
        url.pathname === "/admin-dashboard",
      { timeout: 20000 },
    ),
    page.locator('button[type="submit"]').click(),
  ]);

  uiAuthenticated = true;

  const routes = [
    "/dashboard",
    "/inbox",
    "/conversation-intelligence",
    "/leads",
    "/conversations",
    "/appointments",
    "/revenue-recovery",
    "/intervention-center",
    "/automation",
    "/integrations",
    "/settings",
    "/call-logs",
    "/billing",
  ];

  await fs.mkdir(cfg.reportDir, { recursive: true });
  for (const route of routes) {
    const started = performance.now();
    try {
      const res = await page.goto(`${cfg.uiBase}${route}`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      await page.locator("body").waitFor({
        state: "visible",
        timeout: 10000,
      });

      /*
       * Give React effects/API requests enough time to surface immediate
       * runtime/auth failures without waiting for persistent realtime
       * connections to become idle.
       */
      await page.waitForTimeout(750);
      const durationMs = performance.now() - started;
      const status = res?.status() || 0;
      metrics.push({ label: `ui:${route}`, method: "BROWSER", route, status, ok: status < 500, durationMs });
      if (status >= 500) throw new Error(`HTTP ${status}`);
      const bodyText = (await page.locator("body").innerText()).slice(0, 5000).toLowerCase();
      if (bodyText.includes("application error") || bodyText.includes("something went wrong")) throw new Error("Visible application error text detected");
    } catch (error) {
      failures.push({ phase: "ui", route, error: error.message });
      await page.screenshot({ path: path.join(cfg.reportDir, `${cfg.runTag}-${route.replaceAll("/", "_") || "root"}.png`), fullPage: true }).catch(() => {});
    }
  }
  for (const error of uiErrors) failures.push({ phase: "ui-runtime", error });
  await browser.close();
}

function summary() {
  const durations = metrics.map((m) => m.durationMs).filter(Number.isFinite);
  const failedMetrics = metrics.filter((m) => !m.ok);
  const statuses = {};
  for (const m of metrics) statuses[m.status] = (statuses[m.status] || 0) + 1;
  const byLabel = {};
  for (const m of metrics) {
    const x = byLabel[m.label] ||= { count: 0, failures: 0, durations: [] };
    x.count++; if (!m.ok) x.failures++; x.durations.push(m.durationMs);
  }
  const endpointStats = Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, {
    count: v.count,
    failures: v.failures,
    p50Ms: Number(pct(v.durations, 0.50).toFixed(2)),
    p95Ms: Number(pct(v.durations, 0.95).toFixed(2)),
    p99Ms: Number(pct(v.durations, 0.99).toFixed(2)),
    maxMs: Number(Math.max(...v.durations).toFixed(2)),
  }]));
  return {
    runTag: cfg.runTag,
    generatedAt: new Date().toISOString(),
    target: { api: cfg.apiBase, ui: cfg.uiBase },
    businesses: BUSINESSES.map(({ id, ownerId, name, phone }) => ({ id, ownerId, name, phone })),
    safety: {
      registrationTested: false,
      trialTested: false,
      numberProvisioningTested: false,
      numberPurchasesTested: false,
      heavyRealPhoneLoadPerformed: false,
      providerSideEffectsEnabled: cfg.allowProviderSideEffects,
      liveCallsEnabled: cfg.allowLiveCalls,
      attributionFixturesEnabled: cfg.allowAttributionFixtures,
      attributionFixturesRetained: cfg.keepAttributionFixtures,
      strictAttributionPropagation: cfg.strictAttributionPropagation,
    },
    metrics: {
      requests: metrics.length,
      failures: failedMetrics.length,
      statusCounts: statuses,
      p50Ms: Number(pct(durations, 0.50).toFixed(2)),
      p95Ms: Number(pct(durations, 0.95).toFixed(2)),
      p99Ms: Number(pct(durations, 0.99).toFixed(2)),
      maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : 0,
      endpointStats,
    },
    createdCount: created.length,
    attribution: attributionResults,
    failures,
  };
}

async function writeReport() {
  await fs.mkdir(cfg.reportDir, { recursive: true });
  const report = summary();
  const reportPath = path.join(cfg.reportDir, `${cfg.runTag}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
  console.log(`HTTP/browser operations: ${report.metrics.requests}; metric failures: ${report.metrics.failures}; recorded flow failures: ${failures.length}`);
  console.log(`Latency p50/p95/p99: ${report.metrics.p50Ms}/${report.metrics.p95Ms}/${report.metrics.p99Ms} ms`);
  return report;
}

function usage() {
  console.log(`\nUsage: node callbackiq-real-activity-load.mjs <mode>\n\nModes:\n  preflight      Read-only health/auth/business/API checks\n  attribution    Fake assigned tracking numbers + source/call/lead/conversation/appointment attribution checks\n  load           Heavy synthetic lead/conversation/message/call activity + reads\n  appointments   Availability + appointment hold; confirmation only when provider side effects are enabled\n  webhooks       Capped signed Twilio voice/status/SMS flow (provider side effects possible)\n  live-calls     Capped real Twilio calls to the two existing CallBackIQ numbers\n  live-sms       Capped real customer-style SMS to the two existing numbers\n  ui             Browser smoke across protected app pages; no registration/trial/setup\n  safe-full      preflight + load + attribution + appointment hold + UI (no provider side effects)\n  provider-full  preflight + load + attribution + appointments + signed webhooks + UI; requires explicit side-effect gate\n\nEnvironment loading: ../.env is loaded automatically, then an optional harness .env overlays it. Shell variables always win.\nThe script NEVER calls registration, trial, number-provisioning, number-purchase, A2P onboarding, or tracking-number provisioning endpoints.\n`);
}

async function main() {
  const mode = process.argv[2] || "preflight";
  if (["help", "--help", "-h"].includes(mode)) return usage();
  let sessions;
  try {
    if (["preflight", "attribution", "load", "appointments", "webhooks", "safe-full", "provider-full"].includes(mode)) {
      sessions = await preflight();
    }
    if (["load", "safe-full", "provider-full"].includes(mode)) await syntheticLoad(sessions);
    if (["attribution", "safe-full", "provider-full"].includes(mode)) await attributionSmoke(sessions);
    if (["appointments", "safe-full", "provider-full"].includes(mode)) {
      for (const session of sessions) await appointmentSmoke(session);
    }
    if (["webhooks", "provider-full"].includes(mode)) await providerWebhookSmoke(sessions);
    if (mode === "live-calls") await liveCalls();
    if (mode === "live-sms") await liveSms();
    if (["ui", "safe-full", "provider-full"].includes(mode)) await uiSmoke();
    if (!["preflight", "attribution", "load", "appointments", "webhooks", "live-calls", "live-sms", "ui", "safe-full", "provider-full"].includes(mode)) {
      usage();
      throw new Error(`Unknown mode: ${mode}`);
    }
  } catch (error) {
    failures.push({ phase: "fatal", error: error.message });
    console.error(`\nFATAL: ${error.message}`);
  }
  const report = await writeReport();
  if (failures.length || report.metrics.failures) process.exitCode = 1;
}

await main();
