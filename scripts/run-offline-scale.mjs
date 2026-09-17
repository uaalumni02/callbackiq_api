#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
if ([...args].some(x => !['--persistence', '--soak'].includes(x))) throw new Error('Options: --persistence, --soak');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'callbackiq-offline-'));
const emptyEnv = path.join(scratch, 'empty.env'); fs.writeFileSync(emptyEnv, '');
// Deliberate allowlist: never inherit production DB, Redis, provider credentials,
// NODE_OPTIONS preload hooks, or a local dotenv file into these child processes.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'MONGOMS_SYSTEM_BINARY', 'MONGOMS_DOWNLOAD_DIR'].filter(x => process.env[x]).map(x => [x, process.env[x]]));
Object.assign(env, { NODE_ENV: 'test', TZ: 'UTC', DOTENV_CONFIG_PATH: emptyEnv,
 JWT_SECRET: 'offline-scale-only', OPENAI_API_KEY: 'sk-offline-only',
 TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000', TWILIO_AUTH_TOKEN: 'offline-only',
 STRIPE_SECRET_KEY: 'sk_test_offline', STRIPE_WEBHOOK_SECRET: 'whsec_offline' });
const run = (argv, timeout = 300000, extra = {}) => {
 const result = spawnSync(process.execPath, argv, { cwd: root, env: { ...env, ...extra }, stdio: 'inherit', timeout });
 if (result.error || result.status !== 0) throw new Error(`Offline check failed (${result.error?.message || result.signal || result.status}): ${argv.join(' ')}`);
};
try {
 run(['--test', 'hardening-tests/transportOffline.test.mjs', 'hardening-tests/scaleAcceptance.test.mjs', 'hardening-tests/scaleCapacityRelease.test.mjs']);
 run(['node_modules/jest/bin/jest.js', '--runInBand',
  'tests/unit/voiceAdmission.queue.test.js', 'tests/unit/voiceTopology.offline.test.js',
  'tests/unit/communicationSafety.voiceRelayLimits.test.js', 'tests/unit/conversationRelay.server.test.js',
  'tests/unit/scaleFleet.release.test.js', 'tests/unit/scaleCapacityPlan.release.test.js',
  'tests/unit/remainingCoverage.voice.test.js', 'tests/unit/scaleReadiness.hardening.test.js']);
 run(['perf/voice-relay-transport-load.mjs'], args.has('--soak') ? 600000 : 60000,
  args.has('--soak') ? { VOICE_TRANSPORT_TURNS: '50' } : {});
 if (args.has('--persistence')) {
  // Fail once at startup instead of reporting dozens of secondary DB timeouts.
  run(['scripts/check-isolated-mongo.mjs'], 90000);
  run(['node_modules/jest/bin/jest.js', '--runInBand',
   'tests/integration/voiceConcurrency/voiceConcurrency.certification.test.js',
   'tests/integration/scaleFleet.persistence.test.js', 'tests/integration/scaleRelease.persistence.test.js',
   'tests/integration/scaleQueryPersistence.test.js', 'tests/integration/socketTenantIsolation.authenticated.test.js',
   'tests/routes/ownerExperience.routes.test.js'], 900000);
 }
 console.log('Offline checks passed. Live mixed-load capacity remains unverified.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { fs.rmSync(scratch, { recursive: true, force: true }); }
