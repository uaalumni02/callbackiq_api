import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const api = process.cwd();
const manifest = JSON.parse(fs.readFileSync(process.argv[3] || 'release.json', 'utf8'));
for (const key of ['apiSha', 'frontendSha']) {
  if (!/^[a-f0-9]{40}$/.test(manifest[key] || '')) throw new Error(`Invalid release manifest ${key}.`);
}
const frontendSha = html => html.match(/<meta name="meekcall-build" content="([a-f0-9]{40})"/)?.[1];

function assertSha(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label} SHA mismatch. Expected ${expected}, received ${actual || 'none'}.`);
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', status => status === 0 ? resolve() : reject(new Error(`${cwd}: ${command} ${args.join(' ')} failed.`)));
  });
}

async function fetchBuild(base, pathname) {
  const url = new URL(pathname, base);
  if (url.protocol !== 'https:') throw new Error('Deployment confirmation requires HTTPS endpoints.');
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url.origin} returned HTTP ${response.status}.`);
  return response;
}

if (process.argv[2] === '--confirm') {
  const { MEEKCALL_RELEASE_API_URL, MEEKCALL_RELEASE_FRONTEND_URL } = process.env;
  if (!MEEKCALL_RELEASE_API_URL || !MEEKCALL_RELEASE_FRONTEND_URL) throw new Error('Configure both release deployment URLs.');
  const [apiResponse, frontend] = await Promise.all([
    fetchBuild(MEEKCALL_RELEASE_API_URL, '/version'),
    fetchBuild(MEEKCALL_RELEASE_FRONTEND_URL, '/'),
  ]);
  assertSha('Deployed API', (await apiResponse.json()).sha, manifest.apiSha);
  assertSha('Deployed frontend', frontendSha(await frontend.text()), manifest.frontendSha);
  await run(process.execPath, ['scripts/migrate-required-indexes.mjs', '--check'], api);
  console.log('PASS deployed release', manifest);
} else {
  const frontend = path.resolve(process.argv[2] || '../callbackiq_frontend');
  for (const [directory, sha] of [[api, manifest.apiSha], [frontend, manifest.frontendSha]]) {
    assertSha(directory, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(), sha);
    if (execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }).trim()) {
      throw new Error(`Release checkout must be clean: ${directory}.`);
    }
  }
  const checks = await Promise.allSettled([
    run('npm', ['run', 'verify', ...(process.env.MEEKCALL_API_BASE ? ['--', '--base', process.env.MEEKCALL_API_BASE] : [])], api),
    run('npm', ['run', 'verify', ...(process.env.MEEKCALL_FRONTEND_BASE ? ['--', '--base', process.env.MEEKCALL_FRONTEND_BASE] : [])], frontend),
  ]);
  const failures = checks.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Paired verification failed.');
  const build = (await import(pathToFileURL(path.join(api, 'build/config/build-version.js')))).default;
  assertSha('Built API', build.sha, manifest.apiSha);
  assertSha('Built frontend', frontendSha(fs.readFileSync(path.join(frontend, 'build/index.html'), 'utf8')), manifest.frontendSha);
  await run('npm', ['run', 'test:browser'], api, { ...process.env, CALLBACKIQ_FRONTEND_DIR: frontend });
  console.log('PASS paired release', manifest);
}
