import { createVoiceAdmission } from '../../src/services/voiceAdmission.service.js';
import { inspectRequiredIndex } from '../../src/services/requiredIndexes.service.js';
import { parseAiOutput } from '../../src/helpers/ai/validateAiOutput.js';
import { resolveTrustedRemoteAddress } from '../../src/services/trustedProxyAddress.service.js';
import { buildSmsRecoveryVoicePrompt } from '../../src/voice/smsRecoveryVoicePrompt.service.js';
import { createBoundedRedis } from '../../src/services/boundedRedis.service.js';
import { createServer } from 'node:net';
import bcrypt from '../../src/helpers/bcrypt/bcrypt.js';

test('instance admission reserves pending slots atomically and drains existing calls', () => {
  const a = createVoiceAdmission({ pending: 2, sessions: 2, turns: 1 });
  const first = a.acquireConnection(); const second = a.acquireConnection();
  expect(a.acquireConnection()).toBeNull();
  first.activate(); first.activate();
  expect(a.snapshot()).toMatchObject({ pending: 1, sessions: 1 });
  a.drain(); second.release(); expect(a.acquireConnection()).toBeNull();
  first.release(); first.release(); expect(a.snapshot()).toMatchObject({ pending: 0, sessions: 0 });
});

test('turn capacity remains occupied until the actual operation settles', async () => {
  const a = createVoiceAdmission({ turns: 1 });
  let finish;
  const first = a.runTurn(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  await expect(a.runTurn(async () => {})).rejects.toMatchObject({ code: 'VOICE_ADMISSION_FULL' });
  finish(); await first; await expect(a.runTurn(async () => 7)).resolves.toBe(7);
});

test('an unavailable Redis cannot hold cache fallback indefinitely', async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const redis = createBoundedRedis({ url: () => `redis://127.0.0.1:${port}`, timeoutMs: 50, cooldownMs: 1000 });
  const start = Date.now();
  try {
    await expect(redis.execute(client => client.get('review'))).rejects.toBeDefined();
    expect(Date.now() - start).toBeLessThan(1000);
    await expect(redis.execute(client => client.get('review'))).rejects.toMatchObject({ code: 'REDIS_CIRCUIT_OPEN' });
  } finally { redis.close(); }
});

test('required index verification refuses weakened uniqueness, TTL and partial filters', () => {
  const d = { key: { business: 1, sid: 1 }, options: { unique: true, partialFilterExpression: { sid: { $gt: '' } } } };
  expect(inspectRequiredIndex([{ key: d.key }], d)).toBe('conflict');
  expect(inspectRequiredIndex([{ key: d.key, ...d.options }], d)).toBe('ok');
  expect(inspectRequiredIndex([{ key: { sid: 1, business: 1 }, ...d.options }], d)).toBe('missing');
  expect(inspectRequiredIndex([{ key: { expiresAt: 1 }, expireAfterSeconds: 60 }], { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } })).toBe('conflict');
});

test('AI rejects object-valued fields and bounds strings even inside fenced JSON', () => {
  expect(() => parseAiOutput('{"address":{"$set":"unsafe"}}')).toThrow();
  expect(() => parseAiOutput('[]')).toThrow();
  expect(parseAiOutput('```json\n' + JSON.stringify({ address: 'x'.repeat(900) }) + '\n```').address).toHaveLength(500);
});

test('trusted proxy resolution ignores an attacker prepended forwarded hop', () => {
  const old = { ...process.env };
  process.env.VOICE_TRUST_PROXY_HEADERS = 'true'; process.env.VOICE_TRUSTED_PROXY_IPS = '10.0.0.2,10.0.0.3';
  try {
    expect(resolveTrustedRemoteAddress({ socket: { remoteAddress: '10.0.0.2' }, headers: { 'x-forwarded-for': '198.51.100.88, 203.0.113.20, 10.0.0.3' } })).toBe('203.0.113.20');
    expect(resolveTrustedRemoteAddress({ socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-for': '198.51.100.88' } })).toBe('203.0.113.9');
  } finally { process.env = old; }
});

test('queued SMS does not claim provider acceptance or guaranteed staff response', () => {
  const prompt = buildSmsRecoveryVoicePrompt({ businessName: 'Test', smsEnabled: true, smsStatus: 'queued' });
  expect(prompt).toMatch(/recorded/); expect(prompt).not.toMatch(/on its way|will call|unable to send/i);
});

test('native password hashing accepts existing bcrypt hashes and new hashes', async () => {
  const legacy = await (await import('bcryptjs')).hash('test-password', 4);
  expect(await bcrypt.comparePassword('test-password', legacy)).toBe(true);
  expect(await bcrypt.comparePassword('wrong', legacy)).toBe(false);
  expect(await bcrypt.comparePassword('test-password', await bcrypt.hashPassword('test-password', 4))).toBe(true);
});
