#!/usr/bin/env node
import http from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { initializeConversationRelayServer } from "../src/voice/conversationRelay.server.js";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const int = (name, fallback, max = 100000) => {
  const parsed = Number.parseInt(env(name, fallback), 10);
  return Math.min(max, Math.max(1, Number.isFinite(parsed) ? parsed : Number(fallback)));
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

const clientsWanted = int("VOICE_TRANSPORT_CLIENTS", 100, 2000);
const concurrency = Math.min(clientsWanted, int("VOICE_TRANSPORT_CONCURRENCY", 50, 500));
const turns = int("VOICE_TRANSPORT_TURNS", 3, 20);
const agentDelayMs = int("VOICE_TRANSPORT_AGENT_DELAY_MS", 10, 5000);
const timeoutMs = int("VOICE_TRANSPORT_TIMEOUT_MS", 10000, 60000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const infrastructure = {
  voiceCapacityService: {
    acquireVoiceCapacity: async () => ({ allowed: true }),
    releaseVoiceCapacity: async () => ({ released: true }),
  },
  voiceConnectionLeaseService: {
    acquireVoiceConnectionLease: async () => ({ allowed: true, lease: { id: Math.random() } }),
    releaseVoiceConnectionLease: async () => undefined,
  },
  voiceUsageService: {
    reserveVoiceUsage: async () => ({ allowed: true, reservedSeconds: 60 }),
    reconcileVoiceUsage: async () => undefined,
  },
  voiceFraudDetectionService: {
    evaluateCallerVelocity: async () => ({ allowed: true, count: 1 }),
  },
  voiceTranscriptService: {
    append: async () => undefined,
    markLastAssistantInterrupted: async () => undefined,
    touch: async () => undefined,
  },
  voiceFailureService: { record: async () => undefined },
  voiceOutcomeService: {
    inferVoiceOutcome: () => "direct_answer_resolved",
    commitVoiceOutcome: async () => ({ committed: true }),
    recoverAbandonedVoiceCall: async () => ({ recovered: true }),
  },
  voiceMetricsService: { recordVoiceMetric: async () => undefined },
  voiceSessionService: {
    activateFromSetup: async ({ voiceSessionId, setup }) => ({
      _id: voiceSessionId,
      providerCallSid: setup.callSid,
      providerSessionId: setup.sessionId,
      from: setup.from,
      to: setup.to,
      status: "active",
      startedAt: new Date(),
      metadata: { preflightPassedAt: new Date() },
      transcript: [],
      business: {
        _id: "64b000000000000000000001",
        businessName: "Transport Load Test",
        features: { voiceAiEnabled: true },
        voiceSettings: {
          answerMode: "always",
          maxConcurrentCalls: 100,
          maxCallDurationSeconds: 600,
          callerVelocityLimitPerHour: 1000,
          routingPolicy: { openHours: "voice_ai", afterHours: "voice_ai", voiceFailure: "sms" },
        },
      },
    }),
    touchActivity: async () => undefined,
    sendFallbackSms: async () => undefined,
    markCompleted: async () => undefined,
  },
  voiceAgentService: {
    handlePrompt: async ({ customerMessage }) => {
      await delay(agentDelayMs);
      return { reply: `Load test reply: ${String(customerMessage).slice(0, 60)}` };
    },
  },
};

const server = http.createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
const relayServer = initializeConversationRelayServer(server, {
  ...infrastructure,
  signatureValidator: () => true,
  idleFirstMs: 600000,
  idleSecondMs: 600000,
  idleEndMs: 600000,
  durationLimitMs: 600000,
  maxPendingConnectionsPerIp: 5000,
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const wsUrl = `ws://127.0.0.1:${server.address().port}/ws/voice`;

const connectionLatencies = [];
const turnLatencies = [];
const failures = [];
let next = 0;

const runClient = async (index) => {
  const socket = new WebSocket(wsUrl);
  const connectStarted = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connection timeout")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      connectionLatencies.push(performance.now() - connectStarted);
      resolve();
    });
    socket.once("error", reject);
  });

  socket.send(
    JSON.stringify({
      type: "setup",
      callSid: `CA${String(index).padStart(32, "0").slice(-32)}`,
      sessionId: `VX${String(index).padStart(32, "0").slice(-32)}`,
      from: `+1404555${String(index % 10000).padStart(4, "0")}`,
      to: "+12025550123",
      customParameters: {
        voiceSessionId: `64b${String(index).padStart(21, "0").slice(-21)}`,
        businessId: "64b000000000000000000001",
      },
    }),
  );

  for (let turn = 0; turn < turns; turn += 1) {
    const turnStarted = performance.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("turn timeout"));
      }, timeoutMs);
      const onMessage = (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (message?.type !== "text") return;
        const token = String(message.token || "");
        if (!token.startsWith("Load test reply:")) return;
        cleanup();
        turnLatencies.push(performance.now() - turnStarted);
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({
          type: "prompt",
          voicePrompt: `synthetic caller ${index}, turn ${turn + 1}`,
          last: true,
        }),
      );
    });
  }
  socket.close(1000, "transport load complete");
};

const worker = async () => {
  while (true) {
    const index = next++;
    if (index >= clientsWanted) return;
    try {
      await runClient(index);
    } catch (error) {
      failures.push({ index, error: error?.message || String(error) });
    }
  }
};

const started = performance.now();
try {
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  const report = {
    mode: "in-process-conversation-relay-transport-load",
    clients: clientsWanted,
    concurrency,
    turnsPerClient: turns,
    expectedTurns: clientsWanted * turns,
    completedTurns: turnLatencies.length,
    failures: failures.length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    sessionsPerSecond: Number((clientsWanted / Math.max(0.001, elapsedMs / 1000)).toFixed(2)),
    connectionLatencyMs: {
      p50: Number(percentile(connectionLatencies, 0.5).toFixed(2)),
      p95: Number(percentile(connectionLatencies, 0.95).toFixed(2)),
      p99: Number(percentile(connectionLatencies, 0.99).toFixed(2)),
      max: Number(Math.max(...connectionLatencies, 0).toFixed(2)),
    },
    simulatedTurnLatencyMs: {
      p50: Number(percentile(turnLatencies, 0.5).toFixed(2)),
      p95: Number(percentile(turnLatencies, 0.95).toFixed(2)),
      p99: Number(percentile(turnLatencies, 0.99).toFixed(2)),
      max: Number(Math.max(...turnLatencies, 0).toFixed(2)),
    },
    failureSamples: failures.slice(0, 10),
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length || turnLatencies.length !== clientsWanted * turns) process.exitCode = 1;
} finally {
  await relayServer.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
