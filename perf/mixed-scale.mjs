// Run only against an isolated, provisioned staging fleet. No tenant seeding or secrets are generated here.
import 'dotenv/config';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
const env = process.env;
if (env.SCALE_ALLOW_STAGING_LOAD !== 'true') throw new Error('Set SCALE_ALLOW_STAGING_LOAD=true for your dedicated staging deployment. This test can incur provider costs.');
const tenants = JSON.parse(await fs.readFile(env.SCALE_TENANTS_FILE, 'utf8'));
if (tenants.length < 1001 || new Set(tenants.map(t => t.businessId)).size !== tenants.length || new Set(tenants.map(t => t.to)).size !== tenants.length || tenants.some(t => !t.businessId || !t.to || !t.token)) throw new Error('Provide at least 1001 distinct provisioned businesses with {businessId,to,token}; optional from.');
if (!env.SCALE_API_URL || !env.VOICE_LOAD_HTTP_TARGET || !env.TWILIO_AUTH_TOKEN) throw new Error('SCALE_API_URL, VOICE_LOAD_HTTP_TARGET and TWILIO_AUTH_TOKEN are required.');
const duration = Math.max(60000, Number(env.SCALE_DURATION_MS) || 300000);
const sockets = []; const reads = []; let failures = 0; let stopping = false; const tasks = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const run = (script, extra, args = []) => new Promise(resolve => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'inherit', 'inherit'] });
  tasks.push(child); child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1));
});
try {
  // Bounded connection ramp prevents the load generator itself causing an artificial login burst.
  for (let start = 0; start < tenants.length; start += 25) await Promise.all(tenants.slice(start, start + 25).map(t => new Promise(resolve => {
    const socket = io(env.SCALE_API_URL, { auth: { token: t.token }, transports: ['websocket'], reconnection: true, timeout: 10000 });
    sockets.push(socket);
    const timer = setTimeout(() => { failures++; resolve(); }, 12000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', () => { clearTimeout(timer); failures++; resolve(); });
  })));
  const activeDashboards = sockets.filter(s => s.connected).length;
  if (activeDashboards < 1001) throw new Error(`Only ${activeDashboards} dashboards connected; refusing a misleading capacity result.`);
  const deadline = Date.now() + duration;
  const dashboardTasks = tenants.map(async (t, i) => {
    await delay(i * 10000 / tenants.length);
    while (!stopping && Date.now() < deadline) {
      const started = performance.now();
      try {
        const response = await fetch(`${env.SCALE_API_URL.replace(/\/$/, '')}${env.SCALE_DASHBOARD_PATH || '/api/owner/dashboard'}`, { headers: { authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(15000) });
        await response.arrayBuffer(); if (!response.ok) failures++; else reads.push(performance.now() - started);
      } catch { failures++; }
      if (!stopping) await delay(Math.min(10000, Math.max(0, deadline - Date.now())));
    }
  });
  const codes = await Promise.all([
    run('perf/webhook-burst.mjs', { ALLOW_REMOTE_LOAD_TEST: 'true', PERF_TENANTS_FILE: env.SCALE_TENANTS_FILE, PERF_TARGET_URL: `${env.SCALE_API_URL.replace(/\/$/, '')}/api/twilio/sms`, PERF_TARGET_RPS: '200', PERF_REQUESTS: String(Math.ceil(duration / 1000) * 200), PERF_CONCURRENCY: '300' }),
    run('perf/voice-relay-load.mjs', { ALLOW_REMOTE_LOAD_TEST: 'true', VOICE_LOAD_ALLOW_DB_WRITES: 'true', VOICE_LOAD_ALLOW_AI: 'true', VOICE_LOAD_ALLOW_HIGH_AI: 'true', VOICE_LOAD_TENANTS_FILE: env.SCALE_TENANTS_FILE, VOICE_RELAY_CLIENTS: '300', VOICE_RELAY_EXPECT_ACCEPTED: '300', VOICE_RELAY_CONNECT_CONCURRENCY: '50', VOICE_RELAY_TURNS: '10', VOICE_RELAY_TURN_INTERVAL_MS: String(Math.floor(duration / 12)), VOICE_RELAY_HOLD_MS: '1000' }, ['--ai']),
    Promise.all(dashboardTasks).then(() => 0),
  ]);
  reads.sort((a,b) => a-b);
  const p95 = reads[Math.max(0, Math.ceil(reads.length * .95) - 1)] ?? null;
  const report = { tenants: tenants.length, activeDashboardsAtStart: activeDashboards, activeDashboardsAtEnd: sockets.filter(s => s.connected).length, successfulDashboardReads: reads.length, dashboardP95Ms: p95, failures, childExitCodes: codes };
  console.log(JSON.stringify(report, null, 2));
  if (failures || codes.some(Boolean) || p95 === null || p95 > 1000 || report.activeDashboardsAtEnd < 1001) process.exitCode = 1;
} finally { stopping = true; sockets.forEach(s => s.disconnect()); tasks.forEach(c => { if (c.exitCode === null) c.kill('SIGTERM'); }); }
