#!/usr/bin/env node
/**
 * Read-only MeekCall live gate: explicit negative evidence is fatal.
 * It never sends texts, calls providers, logs in, or changes data.
 * Success still requires manual live SMS/voice/booking certification.
 */
import process from 'node:process';
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; }
function fail(text) { console.error(`FAIL: ${text}`); process.exitCode = 1; }
const origin = option('--api-url') || process.env.MEEKCALL_API_URL || '';
const website = option('--site-url') || process.env.MEEKCALL_SITE_URL || '';
const expectedSha = option('--expected-api-sha') || '';
const requireRemoteWorkers = !args.includes('--allow-unverified-worker-health');
function httpsOrigin(raw, label) {
  try {
    const x = new URL(raw);
    if (x.protocol !== 'https:' || x.username || x.password || x.search || x.hash || x.pathname !== '/') throw Error('not a bare HTTPS origin');
    return x.origin;
  } catch { fail(`${label} must be a bare HTTPS origin without credentials, query, or fragment`); return ''; }
}
const api = httpsOrigin(origin, '--api-url');
const site = website ? httpsOrigin(website, '--site-url') : '';
async function jsonProbe(base, route) {
  const response = await fetch(base + route, {
    method: 'GET', redirect: 'error', headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error(`${route}: HTTP ${response.status}`);
  if (!/application\/json/.test(response.headers.get('content-type') || '')) throw Error(`${route}: API returned non-JSON (possible SPA fallback)`);
  const value = await response.json();
  if (value.success !== true) throw Error(`${route}: success not true`);
  return value;
}
if (api) {
  try {
    const live = await jsonProbe(api, '/api/health/live');
    console.log(`API live: ${live.service}, revision=${live.commit || 'not reported'}, environment=${live.environment || 'not reported'}`);
    if (live.service !== 'callbackiq-api') fail('unexpected API service identity');
    if (expectedSha && !String(live.commit || '').startsWith(expectedSha)) fail('deployed API revision differs from reviewed revision');
  } catch (e) { fail(`${api} live: ${e.message}`); }
  try {
    const ready = await jsonProbe(api, '/api/health/ready');
    const c = ready.checks || {};
    for (const [name, expected] of [['database','connected'],['realtime','ok'],['automation','ok']]) {
      console.log(`${name}: ${c[name] ?? 'missing'}`);
      if (c[name] !== expected) fail(`${name} readiness is not ${expected}`);
    }
    if (c.remoteWorkers === 'not_checked' || c.remoteWorkers == null) {
      if (requireRemoteWorkers) fail('remote workers not certified by readiness; check authenticated /api/admin/scale-health and real completed jobs');
      else console.warn('WARNING: remote workers NOT certified (explicit waiver).');
    } else {
      const remote = c.remoteWorkers;
      const affirmative = remote === true || ['ok', 'healthy', 'ready'].includes(remote) || (typeof remote === 'object' && remote !== null && (remote.ready === true || remote.healthy === true));
      if (!affirmative) fail(`remote worker readiness is not affirmatively healthy: ${JSON.stringify(remote)}`);
      else console.log(`remoteWorkers: ${JSON.stringify(remote)}`);
    }
  } catch (e) { fail(`${api} ready: ${e.message}`); }
}
if (site) {
  try {
    const live = await jsonProbe(site, '/api/health/live');
    if (live.service !== 'callbackiq-api') fail('frontend /api proxy points to an unexpected service');
    console.log(`Frontend API routing: ${live.service}`);
  } catch (e) { fail(`${site} /api routing: ${e.message}`); }
}
console.log('Not tested: cookie persistence on new devices, WebSocket upgrade, SMS handset delivery, voice transfer, worker retries, appointment confirmations, billing.');
