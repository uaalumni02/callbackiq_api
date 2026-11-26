import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Offline fixtures only. Generated canaries are never sent to a provider or printed.
const scanner = process.argv[2] || 'gitleaks';
const config = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
const canary = crypto.createHash('sha512').update('public offline MeekCall scanner canary').digest('base64url');
const publicRevision = crypto.createHash('sha1').update('public offline MeekCall Git revision canary').digest('hex');
const cases = [
  ['release.json', JSON.stringify({ apiSha: publicRevision }, null, 2), 0],
  ['release.json', JSON.stringify({ apiToken: canary }), 1],
  ['tests/integration/pilotDeletion.test.js', 'INTEGRATION_ENCRYPTION_KEY="pilot-encryption-key-with-at-least-32-characters";', 0],
  ['tests/integration/pilotDeletion.test.js', `INTEGRATION_ENCRYPTION_KEY="${canary}";`, 1],
  ['scripts/verify-secret-policy-canaries.mjs', `INTEGRATION_ENCRYPTION_KEY="${canary}";`, 1],
  ['src/outsidePolicy.js', 'INTEGRATION_ENCRYPTION_KEY="pilot-encryption-key-with-at-least-32-characters";', 1],
];
for (const [relative, content, expected] of cases) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-secret-policy-'));
  try {
    const file = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content + '\n', { mode: 0o600 });
    const result = spawnSync(scanner, ['detect', '--source', temporary, '--no-git', '--config', config, '--redact'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== expected) {
      throw new Error(`Secret-policy canary failed: ${relative}, expected ${expected}, received ${result.status}. Install a supported Gitleaks binary; no result was accepted.`);
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
console.log('PASS: exact public hash/test fixtures allowed; unknown credentials and fixtures outside their allowed paths detected.');
