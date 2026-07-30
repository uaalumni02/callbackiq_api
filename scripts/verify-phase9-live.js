import fs from "node:fs/promises";
import process from "node:process";

import twilio from "twilio";
import { WebSocket } from "ws";

const args = new Set(process.argv.slice(2));
const placeCalls = args.has("--place-calls");
const expectForcedFailure = args.has("--expect-forced-failure");
const outputPath =
  process.env.PHASE9_LIVE_REPORT_PATH ||
  `phase9-live-results-${new Date().toISOString().replaceAll(":", "-")}.json`;

const env = (name, fallback = "") =>
  String(process.env[name] || fallback).trim();

const config = {
  accountSid: env("TWILIO_ACCOUNT_SID"),
  authToken: env("TWILIO_AUTH_TOKEN"),
  publicHttpsBaseUrl: env(
    "PHASE9_PUBLIC_HTTPS_BASE_URL",
    env("VOICE_HTTP_PUBLIC_URL"),
  ).replace(/\/+$/, ""),
  publicWssUrl: env(
    "PHASE9_PUBLIC_WSS_URL",
    env("VOICE_WEBSOCKET_PUBLIC_URL"),
  ),
  businessNumber: env("PHASE9_BUSINESS_NUMBER"),
  originatingNumber: env(
    "PHASE9_TEST_ORIGINATING_NUMBER",
    env("PHASE9_TEST_CALLER_NUMBER"),
  ),
  statusCallbackUrl: env("PHASE9_STATUS_CALLBACK_URL"),
};

const required = [
  ["TWILIO_ACCOUNT_SID", config.accountSid],
  ["TWILIO_AUTH_TOKEN", config.authToken],
  ["PHASE9_PUBLIC_HTTPS_BASE_URL or VOICE_HTTP_PUBLIC_URL", config.publicHttpsBaseUrl],
  ["PHASE9_PUBLIC_WSS_URL or VOICE_WEBSOCKET_PUBLIC_URL", config.publicWssUrl],
  ["PHASE9_BUSINESS_NUMBER", config.businessNumber],
];

if (placeCalls) {
  required.push([
    "PHASE9_TEST_ORIGINATING_NUMBER (or legacy PHASE9_TEST_CALLER_NUMBER)",
    config.originatingNumber,
  ]);
}

const missing = required.filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing required Phase 9 live-test environment values:\n- ${missing.join("\n- ")}`);
  process.exitCode = 2;
} else if (!/^https:\/\//i.test(config.publicHttpsBaseUrl)) {
  console.error("The public HTTP base URL must use https://.");
  process.exitCode = 2;
} else if (!/^wss:\/\//i.test(config.publicWssUrl)) {
  console.error("The public WebSocket URL must use wss://.");
  process.exitCode = 2;
}

if (process.exitCode) process.exit();

const report = {
  generatedAt: new Date().toISOString(),
  publicHttpsBaseUrl: config.publicHttpsBaseUrl,
  publicWssUrl: config.publicWssUrl,
  businessNumber: config.businessNumber,
  originatingNumber: placeCalls ? config.originatingNumber : "",
  mode: placeCalls ? "preflight_and_real_calls" : "preflight_only",
  checks: [],
  calls: [],
  manualAcceptance: [],
};

const record = (name, status, details = {}) => {
  report.checks.push({ name, status, ...details });
  const symbol = status === "passed" ? "PASS" : status === "failed" ? "FAIL" : "INFO";
  console.log(`[${symbol}] ${name}${details.message ? ` — ${details.message}` : ""}`);
};

const testHttpsReachability = async () => {
  const url = `${config.publicHttpsBaseUrl}/api/twilio/voice`;
  try {
    const response = await fetch(url, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(10_000),
    });
    record("Public HTTPS endpoint reachable", "passed", {
      statusCode: response.status,
      message: `Received HTTP ${response.status}.`,
    });
  } catch (error) {
    record("Public HTTPS endpoint reachable", "failed", {
      message: error.message,
    });
  }
};

const testRejectedWebSocketSignature = async () => {
  await new Promise((resolve) => {
    const socket = new WebSocket(config.publicWssUrl, {
      headers: { "X-Twilio-Signature": "intentionally-invalid-signature" },
      handshakeTimeout: 10_000,
    });
    let resolved = false;
    const finish = (status, message) => {
      if (resolved) return;
      resolved = true;
      record("Invalid WebSocket signature rejected", status, { message });
      socket.terminate();
      resolve();
    };
    socket.once("open", () =>
      finish("failed", "The server accepted an invalid Twilio signature."),
    );
    socket.once("unexpected-response", (_request, response) => {
      finish(
        response.statusCode === 401 ? "passed" : "failed",
        `Handshake returned HTTP ${response.statusCode}.`,
      );
    });
    socket.once("error", (error) => {
      // ws often reports the expected 401 as an error rather than an
      // unexpected-response event, depending on proxy behavior.
      const rejected = /401|unexpected server response/i.test(error.message);
      finish(rejected ? "passed" : "failed", error.message);
    });
    setTimeout(
      () => finish("failed", "Timed out waiting for handshake rejection."),
      12_000,
    ).unref?.();
  });
};

const testForcedWebSocketTermination = async () => {
  const signature = twilio.getExpectedTwilioSignature(
    config.authToken,
    config.publicWssUrl,
    {},
  );

  await new Promise((resolve) => {
    const socket = new WebSocket(config.publicWssUrl, {
      headers: { "X-Twilio-Signature": signature },
      handshakeTimeout: 10_000,
    });
    const received = [];
    let finished = false;

    const finish = (status, message) => {
      if (finished) return;
      finished = true;
      record("Forced WebSocket failure ends cleanly", status, {
        message,
        receivedTypes: received.map((item) => item.type),
      });
      socket.terminate();
      resolve();
    };

    socket.once("open", () => {
      // A validly signed malformed setup forces the production failure path
      // without requiring a database fixture or weakening the endpoint.
      socket.send(
        JSON.stringify({
          type: "setup",
          callSid: "CA_PHASE9_FORCED_FAILURE",
          sessionId: "VX_PHASE9_FORCED_FAILURE",
          from: config.businessNumber,
          to: config.businessNumber,
          customParameters: {},
        }),
      );
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      received.push(message);
      const hasApology = received.some((item) => item.type === "text");
      const hasEnd = received.some((item) => item.type === "end");
      if (hasApology && hasEnd) {
        finish("passed", "The server sent an apology and an end frame.");
      }
    });

    socket.once("unexpected-response", (_request, response) => {
      finish(
        "failed",
        `The validly signed failure test was rejected with HTTP ${response.statusCode}.`,
      );
    });
    socket.once("error", (error) => finish("failed", error.message));
    socket.once("close", () => {
      const hasApology = received.some((item) => item.type === "text");
      const hasEnd = received.some((item) => item.type === "end");
      if (!finished) {
        finish(
          hasApology && hasEnd ? "passed" : "failed",
          hasApology && hasEnd
            ? "The failure path ended before timeout."
            : "The socket closed without both the apology and end frames.",
        );
      }
    });
    setTimeout(
      () => finish("failed", "Timed out waiting for the forced failure end frame."),
      15_000,
    ).unref?.();
  });
};

const escapeXml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const waitForCallCompletion = async (client, callSid, timeoutMs = 90_000) => {
  const terminalStatuses = new Set([
    "completed",
    "busy",
    "failed",
    "no-answer",
    "canceled",
  ]);
  const deadline = Date.now() + timeoutMs;
  let latest = await client.calls(callSid).fetch();

  while (!terminalStatuses.has(latest.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    latest = await client.calls(callSid).fetch();
  }

  return latest;
};

const placeScriptedCall = async ({ id, name, speech, expected }) => {
  const client = twilio(config.accountSid, config.authToken);
  const statusCallback = config.statusCallbackUrl || undefined;
  const call = await client.calls.create({
    // This must be a Twilio-owned number or verified outgoing caller ID. It
    // calls the staging business number and plays scripted speech into the
    // answered leg, allowing the business number's inbound webhook to run.
    from: config.originatingNumber,
    to: config.businessNumber,
    twiml: `<Response><Pause length="2"/><Say>${escapeXml(
      speech,
    )}</Say><Pause length="12"/></Response>`,
    ...(statusCallback
      ? {
          statusCallback,
          statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
          statusCallbackMethod: "POST",
        }
      : {}),
  });

  const result = {
    id,
    name,
    callSid: call.sid,
    expected,
    status: call.status,
  };
  report.calls.push(result);
  console.log(`[CALL] ${name}: ${call.sid}`);

  try {
    const completed = await waitForCallCompletion(client, call.sid);
    result.status = completed.status;
    result.durationSeconds = Number(completed.duration || 0);
    result.answeredBy = completed.answeredBy || "";
    result.completedAt = new Date().toISOString();
    console.log(`[CALL] ${name} finished with status ${completed.status}.`);
  } catch (error) {
    result.pollingError = error.message;
    console.error(`[WARN] Could not poll ${name} to completion: ${error.message}`);
  }
};

const addManualMatrix = () => {
  report.manualAcceptance = [
    {
      gate: "Answer after hours",
      action: "Set the business after-hours route to AI voice, call while closed, and confirm the greeting starts.",
      expected: "VoiceSession becomes active and ConversationRelay connects.",
    },
    {
      gate: "Approved service",
      action: "Say an active residential service name.",
      expected: "The agent recognizes exactly one approved ServiceOffering.",
    },
    {
      gate: "Service area",
      action: "Provide an address and supported ZIP code.",
      expected: "The agent advances to appointment preference; unsupported ZIP transfers.",
    },
    {
      gate: "Actual availability",
      action: "Request a date with provider availability.",
      expected: "The spoken options match the scheduling provider's returned slots.",
    },
    {
      gate: "Appointment booking",
      action: "Select one option and explicitly confirm it.",
      expected: "A confirmed appointment exists with source=voice and bookedBy=ai.",
    },
    {
      gate: "SMS confirmation",
      action: "Complete the booking from a mobile test number.",
      expected: "Exactly one appointment confirmation SMS is delivered.",
    },
    {
      gate: "Human transfer",
      action: "Say 'Please transfer me to a person.'",
      expected: "The configured staff phone rings; unanswered transfer triggers one SMS and a high-priority alert.",
    },
    {
      gate: "Safety escalation",
      action: "In a controlled test, say 'I smell gas and feel dizzy.'",
      expected: "The caller hears emergency guidance, booking stops, and a critical safety alert/handoff is created.",
    },
    {
      gate: "Voice failure fallback",
      action: "Run against staging with an intentionally unavailable ConversationRelay dependency.",
      expected: "The caller hears an apology, the WebSocket ends, the partial transcript remains, and the configured staff/SMS recovery path runs.",
    },
  ];
};

await testHttpsReachability();
await testRejectedWebSocketSignature();
await testForcedWebSocketTermination();
addManualMatrix();

if (placeCalls) {
  const calls = [
    ...(expectForcedFailure
      ? [
          {
            id: "forced-ws-failure",
            name: "Forced ConversationRelay failure",
            speech: "I need a residential drain cleaning appointment.",
            expected:
              "Staging live-test hook forces relay failure; caller hears an apology and the configured staff/SMS recovery route runs.",
          },
        ]
      : []),
    {
      id: "human-transfer",
      name: "Human transfer request",
      speech: "Please transfer me to a person.",
      expected: "Staff transfer attempt; SMS and alert if unanswered.",
    },
    {
      id: "safety-emergency",
      name: "Gas safety escalation",
      speech: "I smell gas and feel dizzy. This is a controlled system test.",
      expected: "Critical safety escalation and no automated booking.",
    },
    {
      id: "service-start",
      name: "Approved service identification",
      speech: "I need a residential drain cleaning appointment.",
      expected: "The agent identifies an approved service and asks for address/ZIP.",
    },
  ];

  for (const call of calls) {
    try {
      await placeScriptedCall(call);
    } catch (error) {
      report.calls.push({
        ...call,
        status: "failed_to_create",
        error: error.message,
      });
      console.error(`[FAIL] Could not place ${call.name}: ${error.message}`);
    }
  }
}

await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nPhase 9 live report written to ${outputPath}`);
console.log(
  placeCalls
    ? `Real Twilio calls were placed.${expectForcedFailure ? " The forced-failure call expects PHASE9_ENABLE_LIVE_TEST_HOOKS=true and PHASE9_FORCE_RELAY_FAILURE=true on the staging API." : ""} Complete the manual verification fields using Twilio logs, CallBackIQ records, and the recipient phone.`
    : "Preflight completed. Re-run with --place-calls after configuring the Twilio-owned or verified staging originating number.",
);

if (report.checks.some((check) => check.status === "failed")) {
  process.exitCode = 1;
}
