#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(x => x !== '--unit')) throw new Error('Usage: node scripts/verify-repeat-calls.mjs [--unit]');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'callbackiq-repeat-calls-'));
const emptyEnv = path.join(scratch, 'empty.env'); fs.writeFileSync(emptyEnv, '');
// Never load an operator's production database or provider credentials.
const env = Object.fromEntries(['PATH','HOME','TMPDIR','TEMP','SystemRoot','MONGOMS_SYSTEM_BINARY','MONGOMS_DOWNLOAD_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { NODE_ENV: 'test', TZ: 'UTC', DOTENV_CONFIG_PATH: emptyEnv,
  JWT_SECRET: 'repeat-call-test-only', OPENAI_API_KEY: 'sk-offline-only',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000', TWILIO_AUTH_TOKEN: 'offline-only',
  STRIPE_SECRET_KEY: 'sk_test_offline', STRIPE_WEBHOOK_SECRET: 'whsec_offline' });
const run = (argv, timeout = 300000) => {
  const result = spawnSync(process.execPath, argv, { cwd: root, env, stdio: 'inherit', timeout });
  if (result.error || result.status !== 0) throw new Error(`Verification failed (${result.error?.message || result.signal || result.status}): ${argv.join(' ')}`);
};
const unitTests = [
  "tests/unit/recoveryIntake.shared.test.js",
  "tests/unit/customerScenarioMatrix.followthrough.test.js",
  "tests/unit/conversationRelay.server.test.js",
  "tests/unit/communicationSafety.voiceRelayLimits.test.js",
  "tests/unit/voiceAgent.service.test.js",
  "tests/unit/repeatCaller.customerJourney.test.js",
  "tests/unit/voiceSessionFallback.service.test.js",
  "tests/unit/recoverySmsStrict.diffCoverage.test.js",
  "tests/unit/conversationJourney.regression.test.js",
  "tests/unit/voiceBookingStateMachineReuse.test.js",
  "tests/unit/voiceConversationTurn.shared.test.js",
  "tests/unit/smsHumanTakeoverLifecycle.regression.test.js",
  "tests/unit/recoveryIntroduction.diffCoverage.test.js",
  "tests/unit/remainingCoverage.voice.test.js",
  "tests/unit/smsConversation.recoveryJourney.regression.test.js",
  "tests/unit/smsConversation.reopen.test.js",
  "tests/unit/voiceSessionInitialization.service.test.js",
  "tests/unit/voiceCallerVelocity.repeatCalls.test.js",
  "tests/unit/voiceWebhook.controller.test.js",
  "tests/unit/voiceWebhook.liveTransferPhone.test.js",
  "tests/unit/voiceExit.recovery.test.js"
];
try {
  run(['node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath', ...unitTests]);
  run(['scripts/build-production.mjs']);
  run(['scripts/migrate-required-indexes.mjs', '--check-manifest']);
  if (!args.includes('--unit')) {
    run(['scripts/check-isolated-mongo.mjs'], 90000);
    run(['node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath',
      'tests/integration/repeatCaller.persistence.test.js',
      'tests/integration/twilioWebhookIdempotency.test.js',
      'tests/integration/twilioOptOut.test.js',
      'tests/integration/voiceConcurrency/voiceConcurrency.certification.test.js'], 600000);
    console.log('Repeat-call local verification passed, including isolated database tests. Live provider acceptance is still required.');
  } else console.log('Repeat-call unit tests, build and index manifest passed. Database concurrency and live provider acceptance remain unverified.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { fs.rmSync(scratch, { recursive: true, force: true }); }
