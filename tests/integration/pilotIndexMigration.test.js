import path from 'node:path';
import { spawn } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

jest.setTimeout(120000);
test('H05 the real migration fails on missing indexes and passes after applying the current manifest', async () => {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const run = mode => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/migrate-required-indexes.mjs', mode], {
      cwd: path.resolve('.'),
      env: { ...process.env, MONGODB_URI: mongo.getUri(), MONGO_URL: mongo.getUri() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', failure;
    const timeout = setTimeout(() => { failure = new Error('Migration exceeded its test deadline'); child.kill('SIGKILL'); }, 90000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { failure = error; });
    child.on('close', status => { clearTimeout(timeout); resolve({ status, stdout, stderr, error: failure }); });
  });
  try {
    const missing = await run('--check');
    expect(missing.error).toBeUndefined();
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toMatch(/MISSING/);
    const apply = await run('--apply');
    expect(apply.error).toBeUndefined();
    expect({ status: apply.status, error: apply.stderr }).toMatchObject({ status: 0 });
    const checked = await run('--check');
    expect(checked.error).toBeUndefined();
    expect({ status: checked.status, error: checked.stderr }).toMatchObject({ status: 0 });
    const repeated = await run('--apply');
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).not.toMatch(/CREATED/);
  } finally { await mongo.stop(); }
});
