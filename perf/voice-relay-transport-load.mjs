#!/usr/bin/env node
// Transport-only simulation: never a production capacity certificate.
import '../tests/setup/externalProviderSafety.js';
import http from 'node:http';
import { normalizeEmergencyNumberForSpeech } from '../src/voice/voiceSpeech.service.js';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { initializeConversationRelayServer } from '../src/voice/conversationRelay.server.js';
import { createVoiceAdmission } from '../src/services/voiceAdmission.service.js';
if (process.env.NODE_ENV === 'production') throw new Error('Run isolated transport tests outside production.');
// The transport fixture owns all admission dependencies, including session fleet admission.
process.env.VOICE_FLEET_MAX_SESSIONS = '0';
const int = (key, fallback, maximum) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}`);
  return value;
};
const clientsWanted = int('VOICE_TRANSPORT_CLIENTS', 1001, 10000);
const concurrency = Math.min(clientsWanted, int('VOICE_TRANSPORT_CONCURRENCY', 350, 2000));
const connectConcurrency = Math.min(concurrency, int('VOICE_TRANSPORT_CONNECT_CONCURRENCY', 20, 2000));
const businesses = int('VOICE_TRANSPORT_BUSINESSES', clientsWanted, 10000);
const turns = int('VOICE_TRANSPORT_TURNS', 4, 1000);
const agentDelayMs = int('VOICE_TRANSPORT_AGENT_DELAY_MS', 100, 5000);
const timeoutMs = int('VOICE_TRANSPORT_TIMEOUT_MS', 10000, 60000);
const holdMs = int('VOICE_TRANSPORT_HOLD_MS', 1, 600000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const businessIdFor = index => (index % businesses + 1).toString(16).padStart(24, '0');
const observedBusinesses = new Set();
const queueLatencies = [], processingLatencies = [], turnLatencies = [], connectionLatencies = [];
const failures = [], sockets = new Set();
const admission = createVoiceAdmission({
  sessions: int('VOICE_TRANSPORT_SESSION_LIMIT', concurrency, 2000),
  pending: concurrency,
  turns: int('VOICE_TRANSPORT_AI_LIMIT', 50, 2000),
  waitMs: 5000, maxWaiting: concurrency,
  acquireFleetSlot: async () => async () => {}, // Explicitly simulated fleet boundary.
});
const admissionController = {
  ...admission,
  runTurn: (operation, options) => admission.runTurn(operation, { ...options, onTiming: sample => {
    queueLatencies.push(sample.queueWaitMs); processingLatencies.push(sample.processingMs);
  } }),
};
const infrastructure = {
  coordinateConversationTurn: async ({ session, customerMessage, operation }) => {
    const index = Number(/synthetic caller (\d+)/.exec(customerMessage)?.[1]);
    if (String(session.business._id) !== businessIdFor(index)) throw new Error('Business identity mismatch');
    observedBusinesses.add(String(session.business._id));
    return operation();
  },
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
        _id: setup.customParameters.businessId,
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

const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
const relayServer = initializeConversationRelayServer(server, {
  ...infrastructure, admissionController, signatureValidator: () => true,
  idleFirstMs: 600000, idleSecondMs: 600000, idleEndMs: 600000,
  durationLimitMs: 600000, maxPendingConnectionsPerIp: 5000,
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port: 0, host: '127.0.0.1', backlog: 2048 }, resolve); });
const wsUrl = `ws://127.0.0.1:${server.address().port}/ws/voice`;
let peakSessions = 0;
const sampleTimer = setInterval(() => { peakSessions = Math.max(peakSessions, admission.snapshot().sessions); }, 2);
const waitFor = (socket, event, accept = () => true) => new Promise((resolve, reject) => {
  const cleanup = () => { clearTimeout(timer); socket.off(event, success); socket.off('error', error); socket.off('close', close); socket.off('unexpected-response', unexpected); };
  const error = err => { cleanup(); reject(err); };
  const close = () => error(new Error('Socket closed before expected response'));
  const unexpected = (_request, response) => error(new Error(`Handshake HTTP ${response.statusCode}`));
  const success = value => { try { if (!accept(value)) return; cleanup(); resolve(value); } catch (err) { error(err); } };
  const timer = setTimeout(() => error(new Error(`${event} timeout`)), timeoutMs);
  socket.on(event, success); socket.once('error', error); socket.once('close', close); socket.once('unexpected-response', unexpected);
});
const closeClient = async socket => {
  if (!socket) return;
  const closed = new Promise(resolve => { if (socket.readyState === WebSocket.CLOSED) resolve(); else socket.once('close', resolve); });
  socket.terminate(); await closed; sockets.delete(socket);
};
const failure = (index, stage, error) => failures.push({ index, stage, code: error.code || null, error: error.message });
const openClient = async index => {
  const socket = new WebSocket(wsUrl); sockets.add(socket);
  socket.on('error', () => {});
  const began = performance.now();
  try {
    await waitFor(socket, 'open'); connectionLatencies.push(performance.now() - began);
    socket.send(JSON.stringify({ type: 'setup', callSid: `CA${String(index).padStart(32, '0')}`,
      sessionId: `VX${String(index).padStart(32, '0')}`, from: `+1404555${String(index % 10000).padStart(4, '0')}`,
      to: '+12025550123', customParameters: { voiceSessionId: `64b${String(index).padStart(21, '0')}`, businessId: businessIdFor(index) } }));
    return { index, socket };
  } catch (error) { failure(index, 'connect', error); await closeClient(socket); return null; }
};
const runClient = async ({ index, socket }) => {
  try {
    for (let turn = 0; turn < turns; turn++) {
      const prompt = `synthetic caller ${index}, turn ${turn + 1}`;
      const started = performance.now();
      const reply = waitFor(socket, 'message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'text' || !String(message.token).startsWith('Load test reply:')) return false;
        if (message.token !== normalizeEmergencyNumberForSpeech(`Load test reply: ${prompt}`)) throw new Error('Reply identity mismatch');
        return true;
      });
      socket.send(JSON.stringify({ type: 'prompt', voicePrompt: prompt, last: true }));
      await reply; turnLatencies.push(performance.now() - started);
    }
    await delay(holdMs);
  } catch (error) { failure(index, 'turn', error); }
  // Keep completed sockets open until the entire cohort has completed its turns.
};
const cohorts = [];
const runCohort = async start => {
  const size = Math.min(concurrency, clientsWanted - start), clients = [];
  let cursor = 0;
  const connectWorker = async () => {
    while (cursor < size) { const index = start + cursor++; const client = await openClient(index); if (client) clients.push(client); }
  };
  await Promise.all(Array.from({ length: Math.min(connectConcurrency, size) }, connectWorker));
  const deadline = performance.now() + timeoutMs;
  while (admission.snapshot().sessions < clients.length && performance.now() < deadline) await delay(5);
  const activeAtStart = admission.snapshot().sessions;
  peakSessions = Math.max(peakSessions, activeAtStart);
  let minimumActive = activeAtStart;
  const monitor = setInterval(() => { minimumActive = Math.min(minimumActive, admission.snapshot().sessions); }, 2);
  try {
    if (activeAtStart !== size) failure(start, 'setup', new Error(`Expected ${size} active sessions before turns; got ${activeAtStart}`));
    await Promise.all(clients.map(runClient));
    minimumActive = Math.min(minimumActive, admission.snapshot().sessions);
    if (minimumActive !== size) failure(start, 'cohort', new Error(`Active sessions fell below cohort target ${size}`));
    cohorts.push({ requested: size, connected: clients.length, activeAtStart, minimumActiveDuringTurns: minimumActive });
  } finally {
    clearInterval(monitor);
    await Promise.all(clients.map(({ socket }) => closeClient(socket)));
    const drainDeadline = performance.now() + timeoutMs;
    while (admission.snapshot().sessions && performance.now() < drainDeadline) await delay(5);
    if (admission.snapshot().sessions) throw new Error('Cohort failed to drain');
  }
};
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = fraction => Number((sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0).toFixed(2));
  return { count: values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: p(1) };
};
const began = performance.now();
try {
  for (let start = 0; start < clientsWanted; start += concurrency) await runCohort(start);
  // Measure after server-side close callbacks, not before the last socket drains.
  for (let i = 0; i < 100 && admission.snapshot().sessions; i++) await delay(10);
  const state = admission.snapshot();
  const report = { mode: 'isolated-transport-simulation', productionCertified: false,
    mocked: ['signature authentication', 'MongoDB and conversation lock', 'Redis fleet', 'business capacity', 'providers and AI'],
    clients: clientsWanted, businessesExercised: observedBusinesses.size, concurrency, connectConcurrency, connectionMode: connectConcurrency < concurrency ? 'paced-cohort' : 'burst-cohort', peakSessions, cohorts,
    expectedTurns: clientsWanted * turns, completedTurns: turnLatencies.length, failures: failures.length,
    elapsedMs: Number((performance.now() - began).toFixed(2)), agentDelayMs,
    connectionLatencyMs: stats(connectionLatencies), turnLatencyMs: stats(turnLatencies),
    queueWaitMs: stats(queueLatencies), processingMs: stats(processingLatencies), finalAdmission: state, failureSamples: failures.slice(0, 10) };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.VOICE_TRANSPORT_REPORT_PATH) await fs.writeFile(process.env.VOICE_TRANSPORT_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  if (failures.length || turnLatencies.length !== clientsWanted * turns || state.sessions || state.turns || state.waiting) process.exitCode = 1;
} finally {
  clearInterval(sampleTimer); for (const socket of sockets) socket.terminate();
  await relayServer.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
}
