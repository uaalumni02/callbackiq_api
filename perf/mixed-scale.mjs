import { exerciseOwnerReads, OWNER_READ_ROUTES } from './owner-read-workload.mjs';
// Full acceptance cohort: real DB/provider outcomes, signed webhooks, authenticated tenants.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { percentile, validateMixedReport } from './acceptance.mjs';
const env = process.env;
if (env.SCALE_ALLOW_STAGING_LOAD !== 'true') throw new Error('Dedicated staging load requires SCALE_ALLOW_STAGING_LOAD=true; provider costs apply.');
const tenants = JSON.parse(await fs.readFile(env.SCALE_TENANTS_FILE, 'utf8'));
if (Array.isArray(tenants) && tenants.some(t => !/^[a-f0-9]{24}$/i.test(t.probeLeadId || '') || !t.probeSearch)) throw new Error('Supply probeLeadId and probeSearch for every staging tenant, with 1000+ leads per tenant and 21+ messages on the probe customer.');
if (!Array.isArray(tenants) || tenants.length < 1001 || new Set(tenants.map(t => t.businessId)).size !== tenants.length || new Set(tenants.map(t => t.to)).size !== tenants.length || tenants.some(t => !t.businessId || !/^\+\d{10,15}$/.test(t.to) || !/^\+\d{10,15}$/.test(t.from) || !t.token)) throw new Error('Supply 1001+ distinct tenants with businessId, to, authorized from, and owner token.');
for (const name of ['SCALE_API_URL', 'VOICE_LOAD_HTTP_TARGET', 'TWILIO_AUTH_TOKEN', 'SCALE_ADMIN_TOKEN', 'SCALE_API_SHA', 'SCALE_UI_SHA', 'SCALE_CAPACITY_PLAN_SHA256', 'SCALE_IMAGE_DIGEST', 'SCALE_PROVIDER_MODE']) if (!env[name]) throw new Error(`${name} is required`);
const duration = Number(env.SCALE_DURATION_MS || 300000), voiceCount = Number(env.SCALE_VOICE_SESSIONS || 350);
if (!Number.isInteger(duration) || duration < 300000 || duration > 480000 || !Number.isInteger(voiceCount) || voiceCount < 350 || voiceCount > 1000) throw new Error('Use 5–8 minute cohorts with 350–1000 voice sessions; use the soak runner for repeated cohorts.');
const runId = crypto.randomUUID();
const output = path.resolve(env.SCALE_REPORT_DIR || `scale-reports/${runId}`);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const file = name => path.join(output, name);
const base = env.SCALE_API_URL.replace(/\/$/, '');
const sockets = [], reads = [], children = [], fleetSamples = [];
let fleetSampleFailures = 0, healthTimer, healthPending = null;
const ownerReads = Object.fromEntries(OWNER_READ_ROUTES.map(name => [name, { durations: [], failures: 0 }]));
let failures = 0, minimumDashboards = tenants.length, stopping = false, sampleTimer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = async (url, token) => {
  const r = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json(); if (body.success === false) throw new Error('API rejected request'); return body;
};
const sampleHealth = async () => {
  try {
    const state = (await get('/api/admin/scale-health', env.SCALE_ADMIN_TOKEN)).data;
    fleetSamples.push({ ...state, observedAt: new Date().toISOString() });
  } catch { fleetSampleFailures++; }
};
const child = (script, extra, args = [], barrier = false) => {
  const process = spawn(globalThis.process.execPath, [script, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'inherit', 'inherit', ...(barrier ? ['ipc'] : [])] });
  children.push(process);
  const done = new Promise(resolve => { process.once('error', () => resolve(1)); process.once('exit', code => resolve(code ?? 1)); });
  const ready = barrier ? new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Voice cohort did not become ready')), 240000);
    process.once('message', message => { clearTimeout(timer); message?.type === 'ready' ? resolve() : reject(new Error('Unexpected child message')); });
    process.once('exit', () => { clearTimeout(timer); reject(new Error('Voice exited before workload start')); });
    process.once('error', reject);
  }) : Promise.resolve();
  return { process, done, ready };
};
let report = { schemaVersion: 2, runId, apiSha: env.SCALE_API_SHA, uiSha: env.SCALE_UI_SHA, tenants: tenants.length, durationMs: duration, failures: 1, providerMode: env.SCALE_PROVIDER_MODE, capacityPlanSha256: env.SCALE_CAPACITY_PLAN_SHA256, imageDigest: env.SCALE_IMAGE_DIGEST };
try {
  // Validate identity through the authenticated API, not merely the manifest.
  for (let i = 0; i < tenants.length; i += 25) await Promise.all(tenants.slice(i, i + 25).map(async tenant => {
    const owned = await get('/api/businesses/mine', tenant.token);
    if (String(owned.data?._id) !== tenant.businessId) throw new Error('Tenant token does not own its declared business');
    await new Promise((resolve, reject) => {
      const socket = io(base, { auth: { token: tenant.token }, transports: ['websocket'], reconnection: false, timeout: 10000 });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('Dashboard connection timed out')), 12000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Dashboard authentication failed')); });
    });
  }));
  const before = (await get('/api/admin/scale-health', env.SCALE_ADMIN_TOKEN)).data;
  if (!before.healthy || !before.releases?.includes(env.SCALE_API_SHA) || before.releases.some(x => x !== env.SCALE_API_SHA)) throw new Error('Fleet health or deployed release identity is not ready');
  const voice = child('perf/voice-relay-load.mjs', {
    ALLOW_REMOTE_LOAD_TEST: 'true', VOICE_LOAD_ALLOW_DB_WRITES: 'true', VOICE_LOAD_ALLOW_AI: 'true', VOICE_LOAD_ALLOW_HIGH_AI: 'true',
    VOICE_LOAD_TENANTS_FILE: env.SCALE_TENANTS_FILE, VOICE_LOAD_RUN_ID: runId,
    VOICE_RELAY_CLIENTS: String(voiceCount), VOICE_RELAY_EXPECT_ACCEPTED: String(voiceCount),
    VOICE_RELAY_CONNECT_CONCURRENCY: env.SCALE_BURST === 'true' ? String(voiceCount) : '50',
    VOICE_RELAY_TURNS: '20', VOICE_RELAY_TURN_INTERVAL_MS: String(Math.floor(duration / 25)),
    VOICE_RELAY_MIN_DURATION_MS: String(duration), VOICE_RELAY_REPORT_PATH: file('voice.json'),
  }, ['--ai'], true);
  await voice.ready;
  const started = performance.now(), deadline = started + duration;
  sampleTimer = setInterval(() => { minimumDashboards = Math.min(minimumDashboards, sockets.filter(s => s.connected).length); }, 100);
  report.startedAt = new Date().toISOString();
  healthPending = sampleHealth();
  healthTimer = setInterval(() => {
    if (healthPending) return;
    healthPending = sampleHealth().finally(() => { healthPending = null; });
  }, 5000);
  healthPending.finally(() => { healthPending = null; });
  voice.process.send({ type: 'begin' });
  const sms = child('perf/webhook-burst.mjs', { ALLOW_REMOTE_LOAD_TEST: 'true', PERF_TENANTS_FILE: env.SCALE_TENANTS_FILE,
    SCALE_RUN_ID: runId, PERF_TARGET_URL: `${base}/api/twilio/sms`, PERF_TARGET_RPS: '200', PERF_REQUESTS: String(Math.ceil(duration / 1000) * 200), PERF_CONCURRENCY: '300',
    PERF_REPORT_PATH: file('sms.json'), SCALE_SMS_IDENTITIES_FILE: file('sms-identities.json') });
  const dashboard = Promise.all(tenants.map(async (tenant, index) => {
    await delay(index * 10000 / tenants.length);
    while (!stopping && performance.now() < deadline) {
      const began = performance.now();
      try {
        await get('/api/owner/dashboard', tenant.token); reads.push(performance.now() - began);
        await exerciseOwnerReads({ get, tenant, observe: (name, ms, ok) => {
          ownerReads[name].durations.push(ms); if (!ok) ownerReads[name].failures++;
        } });
      }
      catch { failures++; }
      await delay(Math.max(0, Math.min(10000, deadline - performance.now())));
    }
  }));
  // End the measured interval on its clock, not after child shutdown/audit.
  // Setup and drain time must not inflate the certified soak duration.
  const measuredWindow = delay(Math.max(0, deadline - performance.now())).then(async () => {
    report.endedAt = new Date().toISOString();
    report.durationMs = performance.now() - started;
    clearInterval(healthTimer); await healthPending;
    clearInterval(sampleTimer);
    minimumDashboards = Math.min(minimumDashboards, sockets.filter(s => s.connected).length);
  });
  const childExitCodes = await Promise.all([voice.done, sms.done, dashboard.then(() => 0)]);
  await measuredWindow;

  const audit = child('perf/audit-sms-outcomes.mjs', { SCALE_SMS_IDENTITIES_FILE: file('sms-identities.json'), SCALE_OUTCOME_REPORT_PATH: file('outcomes.json') });
  childExitCodes.push(await audit.done);
  const after = (await get('/api/admin/scale-health', env.SCALE_ADMIN_TOKEN)).data;
  if (!after.healthy || after.releases.some(x => x !== env.SCALE_API_SHA)) failures++;
  report = { ...report, before, after, fleetSamples, fleetSampleFailures, minimumDashboards, failures, childExitCodes,
    ownerReads: Object.fromEntries(Object.entries(ownerReads).map(([name, row]) => [name, { count: row.durations.length, failures: row.failures, p95Ms: percentile(row.durations, .95), p99Ms: percentile(row.durations, .99) }])),
    dashboardP95Ms: percentile(reads, .95), successfulDashboardReads: reads.length,
    voice: JSON.parse(await fs.readFile(file('voice.json'), 'utf8')),
    sms: JSON.parse(await fs.readFile(file('sms.json'), 'utf8')),
    outcomes: JSON.parse(await fs.readFile(file('outcomes.json'), 'utf8')) };
  report.acceptanceErrors = validateMixedReport(report, { voice: voiceCount, durationMs: duration, requireOwnerReads: true, requireOperationalEvidence: true });
} catch (error) {
  // Do not serialize URLs, response payloads, tokens, or provider data.
  report.acceptanceErrors = ['workload_incomplete']; report.failure = String(error.message).slice(0, 200);
} finally {
  stopping = true; clearInterval(healthTimer); await healthPending; clearInterval(sampleTimer); sockets.forEach(s => s.disconnect());
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  report.passed = report.acceptanceErrors?.length === 0;
  await fs.writeFile(file('mixed.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: file('mixed.json'), passed: report.passed, errors: report.acceptanceErrors }));
  if (!report.passed) process.exitCode = 1;
}
