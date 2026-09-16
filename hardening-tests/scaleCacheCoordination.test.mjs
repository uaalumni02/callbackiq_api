import { capacityFixture } from './capacityFixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCacheRefreshCoordinator } from '../src/services/scale/cacheRefresh.service.js';
import { sizeSmsWorkers } from '../scripts/scale-sms-sizing.mjs';
function fakeRedis() {
  const values = new Map();
  const get = key => { const value = values.get(key); if (value?.until <= Date.now()) { values.delete(key); return null; } return value?.data || null; };
  const client = { get: async key => get(key), set: async (key, data, options) => {
    if (options.NX && get(key)) return null;
    values.set(key, { data, until: Date.now() + options.PX }); return 'OK';
  }, eval: async (_script, { keys, arguments: args }) => {
    if (get(keys[0]) !== args[0]) return 0;
    if (keys.length === 2) values.set(keys[1], { data: args[1], until: Date.now() + Number(args[2]) });
    values.delete(keys[0]); return 1;
  } };
  return { values, execute: operation => operation(client) };
}
test('independent replicas share one cold refresh and reuse its publication', async () => {
  const redis = fakeRedis(); let loads = 0;
  const replicas = Array.from({length: 6}, () => createCacheRefreshCoordinator({ execute: redis.execute, pollMs: 5 }));
  const load = async () => { loads++; await new Promise(r => setTimeout(r, 30)); return { total: 12 }; };
  const results = await Promise.all(replicas.map(run => run({ key: 'tenant:a', load, ttlMs: 1000, staleMs: 3000 })));
  assert.equal(loads, 1); assert.ok(results.every(x => x.value.total === 12));
});
test('a busy cold key times out without running another database loader', async () => {
  const redis = fakeRedis(); redis.values.set('key:refresh', { data: 'other', until: Date.now() + 10000 });
  let loads = 0;
  const run = createCacheRefreshCoordinator({ execute: redis.execute, waitMs: 20, pollMs: 5 });
  await assert.rejects(run({ key: 'key', load: async () => ++loads, ttlMs: 1000, staleMs: 3000 }), { code: 'CACHE_REFRESH_BUSY' });
  assert.equal(loads, 0);
});
test('a stale replica never overwrites a newer owner after losing its token', async () => {
  const redis = fakeRedis();
  const run = createCacheRefreshCoordinator({ execute: redis.execute });
  await assert.rejects(run({ key: 'key', ttlMs: 1000, staleMs: 3000, load: async () => {
    redis.values.set('key:refresh', { data: 'new-owner', until: Date.now() + 10000 }); return 'old-result';
  } }), { code: 'CACHE_REFRESH_BUSY' });
  assert.equal(redis.values.get('key:refresh').data, 'new-owner');
  assert.equal(redis.values.has('key'), false);
});
test('shared stale data can be served during another owners refresh', async () => {
  const redis = fakeRedis(), stale = { value: 7, freshUntil: 1, staleUntil: Date.now() + 1000 };
  redis.values.set('key', { data: JSON.stringify(stale), until: stale.staleUntil });
  redis.values.set('key:refresh', { data: 'other', until: Date.now() + 10000 });
  const result = await createCacheRefreshCoordinator({ execute: redis.execute })({ key: 'key', load: async () => { throw new Error('must not load'); } });
  assert.equal(result.value, 7);
});
test('SMS sizing includes utilization and one lost replica; invalid measurements fail', () => {
  assert.equal(sizeSmsWorkers({ jobsPerSecond: 200, processingP95Ms: 2000 }).requiredReplicas, 26);
  assert.throws(() => sizeSmsWorkers({ jobsPerSecond: 200, processingP95Ms: 0 }));
  assert.throws(() => sizeSmsWorkers({ jobsPerSecond: 200, processingP95Ms: 2000, utilization: 1 }));
});

test('capacity certificate rejects missing or incomplete expensive-route evidence', async () => {
  const { validateOwnerReadReport, OWNER_READ_ROUTES } = await import('../perf/owner-read-workload.mjs');
  assert.equal(validateOwnerReadReport({}).length, OWNER_READ_ROUTES.length);
  const rows = Object.fromEntries(OWNER_READ_ROUTES.map(route => [route, { count: 1001, failures: 0, p95Ms: 400, p99Ms: 800 }]));
  assert.deepEqual(validateOwnerReadReport(rows), []);
  rows['customer-history'].count = 0;
  assert.deepEqual(validateOwnerReadReport(rows), ['owner_read:customer-history']);
});

test('optional autoscaling budgets maximum replicas and demands a metrics adapter', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'callbackiq-render-'));
  try {
    const file = join(dir, 'deployment.json');
    const planFile = join(dir, 'plan.json');
    await writeFile(planFile, JSON.stringify(capacityFixture()));
    const env = { SCALE_CAPACITY_PLAN: planFile, SCALE_MONGO_CONNECTION_BUDGET: '2000', ...process.env, SCALE_IMAGE: `example/app@sha256:${'0'.repeat(64)}`, RELEASE_SHA: 'a'.repeat(40),
      SCALE_INGRESS_HOST: 'example.test', SCALE_TLS_SECRET: 'test-tls', SCALE_DEPLOYMENT_FILE: file,
      SCALE_AUTOSCALING_ENABLED: 'true', SCALE_MAX_REPLICAS_API: '8', SCALE_MAX_REPLICAS_WORKER_SMS: '30' };
    const script = new URL('../deploy/scale/render.mjs', import.meta.url);
    const blocked = spawnSync(process.execPath, [script.pathname], { env: { ...env, SCALE_SMS_METRICS_ADAPTER_READY: 'false' } });
    assert.notEqual(blocked.status, 0);
    const rendered = spawnSync(process.execPath, [script.pathname], { env: { ...env, SCALE_SMS_METRICS_ADAPTER_READY: 'true' } });
    assert.equal(rendered.status, 0, rendered.stderr.toString());
    const deployment = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(deployment.items.filter(x => x.kind === 'HorizontalPodAutoscaler').length, 2);
    const config = deployment.items.find(x => x.kind === 'ConfigMap').data;
    assert.equal(Number(config.SCALE_MONGO_DECLARED_CONNECTIONS), 1660);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
