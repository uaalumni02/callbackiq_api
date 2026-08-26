#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const { getExpectedTwilioSignature } = require("twilio/lib/webhooks/webhooks");

const args = new Set(process.argv.slice(2));
const aiMode = args.has("--ai");
const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const flag = (name) => env(name).toLowerCase() === "true";
const int = (name, fallback, max = 100000) => {
  const parsed = Number.parseInt(env(name, fallback), 10);
  return Math.min(max, Math.max(1, Number.isFinite(parsed) ? parsed : Number(fallback)));
};
const trimSlash = (value) => String(value || "").replace(/\/+$/, "");
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

const httpTargetBase = trimSlash(env("VOICE_LOAD_HTTP_TARGET", "http://127.0.0.1:3000"));
const signatureHttpBase = trimSlash(
  env("VOICE_LOAD_SIGNATURE_HTTP_BASE", env("TWILIO_WEBHOOK_BASE_URL", httpTargetBase)),
);
const httpVoiceUrl = `${httpTargetBase}/api/twilio/voice`;
const signatureVoiceUrl = `${signatureHttpBase}/api/twilio/voice`;
const wsTarget = env(
  "VOICE_LOAD_WS_TARGET",
  `${httpTargetBase.replace(/^http/i, "ws")}/ws/voice`,
);
const signatureWsUrl = env(
  "VOICE_LOAD_SIGNATURE_WS_URL",
  env("VOICE_WEBSOCKET_PUBLIC_URL", wsTarget),
);
const authToken = env("TWILIO_AUTH_TOKEN");
const accountSid = env("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
const to = env("VOICE_LOAD_TO", "+12025550123");
const fromBase = env("VOICE_LOAD_FROM_BASE", "+14045550000");
const runId = env("VOICE_LOAD_RUN_ID", new Date().toISOString());
const clientsWanted = int("VOICE_RELAY_CLIENTS", aiMode ? 5 : 50, 1000);
const connectConcurrency = Math.min(
  clientsWanted,
  int("VOICE_RELAY_CONNECT_CONCURRENCY", 5, 50),
);
const setupSettleMs = int("VOICE_RELAY_SETUP_SETTLE_MS", 1100, 10000);
const holdMs = int("VOICE_RELAY_HOLD_MS", 1500, 60000);
const turnTimeoutMs = int("VOICE_RELAY_TURN_TIMEOUT_MS", 20000, 120000);
const turns = aiMode ? int("VOICE_RELAY_TURNS", 2, 10) : 0;
const expectedAccepted = int(
  "VOICE_RELAY_EXPECT_ACCEPTED",
  Math.min(clientsWanted, int("VOICE_LOAD_MAX_CONCURRENT", 25, 100)),
  1000,
);
const outputPath = env(
  "VOICE_RELAY_REPORT_PATH",
  `voice-relay-load-${aiMode ? "ai-" : "capacity-"}${new Date().toISOString().replaceAll(":", "-")}.json`,
);

if (!authToken) throw new Error("TWILIO_AUTH_TOKEN is required.");
if (!flag("VOICE_LOAD_ALLOW_DB_WRITES")) {
  throw new Error("Set VOICE_LOAD_ALLOW_DB_WRITES=true only for the dedicated load-test database.");
}
if (aiMode && !flag("VOICE_LOAD_ALLOW_AI")) {
  throw new Error("AI relay mode can consume OpenAI tokens. Set VOICE_LOAD_ALLOW_AI=true to opt in.");
}
if (aiMode && clientsWanted > 10 && !flag("VOICE_LOAD_ALLOW_HIGH_AI")) {
  throw new Error(
    `AI mode requested ${clientsWanted} clients. The default safety cap is 10. Set VOICE_LOAD_ALLOW_HIGH_AI=true only if intentional.`,
  );
}

const target = new URL(httpTargetBase);
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (!localHosts.has(target.hostname) && !flag("ALLOW_REMOTE_LOAD_TEST")) {
  throw new Error(`Refusing remote load test against ${target.hostname}.`);
}

const sidFor = (kind, index) => {
  const prefix = kind === "call" ? "CA" : "VX";
  return `${prefix}${createHash("sha256").update(`${runId}:${kind}:${index}`).digest("hex").slice(0, 32)}`;
};
const callerFor = (index) => {
  const digits = fromBase.replace(/\D/g, "");
  const width = 5;
  const head = digits.slice(0, Math.max(1, digits.length - width));
  const tail = Number.parseInt(digits.slice(-width), 10) || 0;
  return `+${head}${String((tail + index) % 100000).padStart(width, "0")}`;
};
const xmlDecode = (value) =>
  String(value || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const parseParameters = (twiml) => {
  const params = {};
  for (const match of twiml.matchAll(/<Parameter\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/gi)) {
    params[xmlDecode(match[1])] = xmlDecode(match[2]);
  }
  return params;
};

const createVoiceSession = async (index) => {
  const callSid = sidFor("call", index);
  const from = callerFor(index);
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: from,
    To: to,
    Caller: from,
    Called: to,
    Direction: "inbound",
    CallStatus: "ringing",
    ApiVersion: "2010-04-01",
  };
  const signature = getExpectedTwilioSignature(authToken, signatureVoiceUrl, params);
  const started = performance.now();
  const response = await fetch(httpVoiceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const twiml = await response.text();
  const relay = /<ConversationRelay\b/i.test(twiml);
  if (!response.ok || !relay) {
    throw new Error(
      `Voice bootstrap ${index} failed: HTTP ${response.status}, relay=${relay}, body=${twiml.slice(0, 300)}`,
    );
  }
  const customParameters = parseParameters(twiml);
  if (!customParameters.voiceSessionId || !customParameters.businessId) {
    throw new Error(`Voice bootstrap ${index} returned relay TwiML without required custom parameters.`);
  }
  return {
    index,
    callSid,
    from,
    customParameters,
    bootstrapLatencyMs: performance.now() - started,
  };
};

const wsSignature = getExpectedTwilioSignature(authToken, signatureWsUrl, {});

const openRelay = async (bootstrap) => {
  const socket = new WebSocket(wsTarget, {
    headers: { "X-Twilio-Signature": wsSignature },
    handshakeTimeout: 10000,
  });
  const messages = [];
  let openedAt = 0;
  const connectStarted = performance.now();
  socket.on("message", (raw) => {
    try {
      messages.push({ at: performance.now(), message: JSON.parse(raw.toString("utf8")) });
    } catch {
      // Keep malformed-provider-frame behavior observable without crashing the harness.
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("open", () => {
      openedAt = performance.now();
      resolve();
    });
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`WebSocket handshake returned HTTP ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });

  const sessionId = sidFor("session", bootstrap.index);
  socket.send(
    JSON.stringify({
      type: "setup",
      callSid: bootstrap.callSid,
      sessionId,
      accountSid,
      from: bootstrap.from,
      to,
      direction: "inbound",
      callType: "PSTN",
      customParameters: bootstrap.customParameters,
    }),
  );

  /*
   * Wait for a deterministic setup-complete marker from the API rather than
   * guessing from elapsed time. The marker exists only in synthetic load mode.
   */
  await new Promise((resolve) => {
    const deadline = setTimeout(resolve, 15_000);

    const setupResolved = () =>
      messages.some(({ message }) => {
        if (message?.type === "callbackiq_setup_ready") return true;
        if (message?.type === "end") return true;

        const token = String(message?.token || "");
        return (
          message?.type === "text" &&
          /trouble continuing|capacity is temporarily unavailable|allowance is exhausted/i.test(token)
        );
      });

    if (setupResolved() || socket.readyState !== WebSocket.OPEN) {
      clearTimeout(deadline);
      resolve();
      return;
    }

    const cleanup = () => {
      clearTimeout(deadline);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    const onMessage = () => {
      if (!setupResolved()) return;
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    socket.on("message", onMessage);
    socket.once("close", onClose);
  });

  const setupFailure = messages.find(({ message }) => {
    if (message?.type === "end") return true;

    const token = String(message?.token || "");
    return (
      message?.type === "text" &&
      /trouble continuing|capacity is temporarily unavailable|allowance is exhausted/i.test(token)
    );
  });

  const setupSucceeded = messages.some(
    ({ message }) => message?.type === "callbackiq_setup_ready",
  );

  const accepted =
    socket.readyState === WebSocket.OPEN &&
    setupSucceeded &&
    !setupFailure;
  return {
    socket,
    messages,
    accepted,
    rejection: setupFailure?.message || null,
    connectionLatencyMs: openedAt - connectStarted,
    bootstrapLatencyMs: bootstrap.bootstrapLatencyMs,
  };
};

const defaultPrompts = [
  "My kitchen sink is leaking under the cabinet. I am only testing the assistant and I do not want to book an appointment.",
  "The leak is steady but there is no flooding. Please give me the next safe step without booking anything.",
];
const prompts = (() => {
  if (!env("VOICE_LOAD_PROMPTS_JSON")) return defaultPrompts;
  const parsed = JSON.parse(env("VOICE_LOAD_PROMPTS_JSON"));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("VOICE_LOAD_PROMPTS_JSON must be a non-empty JSON array.");
  return parsed.map((value) => String(value).slice(0, 1000));
})();

const waitForAgentReply = (relay, prompt) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const ignored = /^(?:Got it\.?|One moment\.?|Entiendo\.?)$/i;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for agent reply to: ${prompt.slice(0, 80)}`));
    }, turnTimeoutMs);
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (message?.type === "end") {
        cleanup();
        resolve({ latencyMs: performance.now() - started, ended: true, message });
        return;
      }
      if (message?.type !== "text") return;
      const token = String(message.token || "").trim();
      if (!token || ignored.test(token)) return;
      cleanup();
      resolve({ latencyMs: performance.now() - started, ended: false, message });
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Relay closed before the agent produced a final reply."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      relay.socket.off("message", onMessage);
      relay.socket.off("close", onClose);
    };
    relay.socket.on("message", onMessage);
    relay.socket.once("close", onClose);
    relay.socket.send(
      JSON.stringify({ type: "prompt", voicePrompt: prompt, last: true }),
    );
  });

const relays = [];
const failures = [];
let next = 0;
const worker = async () => {
  while (true) {
    const index = next++;
    if (index >= clientsWanted) return;
    try {
      const bootstrap = await createVoiceSession(index);
      const relay = await openRelay(bootstrap);
      relays.push({ ...relay, index, callSid: bootstrap.callSid });
      if (!relay.accepted) {
        setTimeout(() => relay.socket.terminate(), 100).unref?.();
      }
    } catch (error) {
      failures.push({ index, error: error?.message || String(error) });
    }
  }
};

const runStarted = performance.now();
await Promise.all(Array.from({ length: connectConcurrency }, worker));
const acceptedRelays = relays.filter((relay) => relay.accepted);
const rejectedRelays = relays.filter((relay) => !relay.accepted);
const turnLatencies = [];
const turnFailures = [];

if (aiMode) {
  await Promise.all(
    acceptedRelays.map(async (relay) => {
      for (let turn = 0; turn < turns; turn += 1) {
        try {
          const result = await waitForAgentReply(relay, prompts[turn % prompts.length]);
          turnLatencies.push(result.latencyMs);
          if (result.ended) break;
        } catch (error) {
          turnFailures.push({ relay: relay.index, turn: turn + 1, error: error.message });
          break;
        }
      }
    }),
  );
}

await new Promise((resolve) => setTimeout(resolve, holdMs));

for (const relay of acceptedRelays) {
  try {
    if (relay.socket.readyState === WebSocket.OPEN) {
      relay.socket.send(
        JSON.stringify({
          type: "callbackiq_test_complete",
          outcome: aiMode
            ? "direct_answer_resolved"
            : "caller_declined",
        }),
      );
    }
  } catch {
    relay.socket.terminate();
  }
}

/*
 * Give the API time to commit the synthetic terminal outcome, release
 * capacity, enqueue reconciliation, acknowledge completion, and close.
 */
await new Promise((resolve) => setTimeout(resolve, 1200));

for (const relay of relays) {
  if (relay.socket.readyState !== WebSocket.CLOSED) {
    relay.socket.terminate();
  }
}

const runElapsedMs = performance.now() - runStarted;
const connectionLatencies = relays.map((relay) => relay.connectionLatencyMs);
const bootstrapLatencies = relays.map((relay) => relay.bootstrapLatencyMs);
const report = {
  generatedAt: new Date().toISOString(),
  mode: aiMode ? "integrated-relay-ai-load" : "integrated-relay-capacity-load",
  httpVoiceUrl,
  wsTarget,
  signatureVoiceUrl,
  signatureWsUrl,
  requestedClients: clientsWanted,
  connectConcurrency,
  accepted: acceptedRelays.length,
  expectedAccepted,
  rejectedByServer: rejectedRelays.length,
  harnessFailures: failures.length,
  aiTurnsPerAcceptedClient: turns,
  completedAiTurns: turnLatencies.length,
  aiTurnFailures: turnFailures.length,
  elapsedMs: Number(runElapsedMs.toFixed(2)),
  bootstrapLatencyMs: {
    p50: Number(percentile(bootstrapLatencies, 0.5).toFixed(2)),
    p95: Number(percentile(bootstrapLatencies, 0.95).toFixed(2)),
    p99: Number(percentile(bootstrapLatencies, 0.99).toFixed(2)),
    max: Number(Math.max(...bootstrapLatencies, 0).toFixed(2)),
  },
  websocketConnectionLatencyMs: {
    p50: Number(percentile(connectionLatencies, 0.5).toFixed(2)),
    p95: Number(percentile(connectionLatencies, 0.95).toFixed(2)),
    p99: Number(percentile(connectionLatencies, 0.99).toFixed(2)),
    max: Number(Math.max(...connectionLatencies, 0).toFixed(2)),
  },
  ...(aiMode
    ? {
        aiTurnLatencyMs: {
          p50: Number(percentile(turnLatencies, 0.5).toFixed(2)),
          p95: Number(percentile(turnLatencies, 0.95).toFixed(2)),
          p99: Number(percentile(turnLatencies, 0.99).toFixed(2)),
          max: Number(Math.max(...turnLatencies, 0).toFixed(2)),
        },
      }
    : {}),
  rejectionSamples: rejectedRelays.slice(0, 10).map((relay) => ({
    index: relay.index,
    rejection: relay.rejection,
  })),
  harnessFailureSamples: failures.slice(0, 10),
  aiTurnFailureSamples: turnFailures.slice(0, 10),
};

await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
console.log(`Report: ${outputPath}`);

if (
  acceptedRelays.length !== expectedAccepted ||
  failures.length > 0 ||
  (aiMode && turnFailures.length > 0)
) {
  process.exitCode = 1;
}
