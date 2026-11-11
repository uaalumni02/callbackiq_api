#!/usr/bin/env node
/**
 * MeekCall offline architecture contract checks.
 * Read-only. Cannot certify live Twilio, MongoDB, Redis, cookies, or workers.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
let checks = 0;
function source(file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); }
  catch (error) { failures.push(`${file}: cannot read (${error.code || error.message})`); return ''; }
}
function requireTokens(file, tokens) {
  const value = source(file);
  for (const token of tokens) {
    checks++;
    if (!value.includes(token)) failures.push(`${file}: missing expected contract: ${token}`);
  }
}
function requireBefore(file, before, after) {
  const value = source(file);
  checks++;
  if (value.indexOf(before) < 0 || value.indexOf(after) < 0 || value.indexOf(before) >= value.indexOf(after)) {
    failures.push(`${file}: routing/operation ordering changed`);
  }
}

requireTokens('src/config/env.js', [
  'RECOVERY_SMS_ASYNC_ENABLED', 'TWILIO_VALIDATE_SIGNATURES',
  'ALLOW_UNSIGNED_PROVIDER_WEBHOOKS', 'CSRF_ALLOW_MISSING_ORIGIN',
  'AUTH_RESPONSE_TOKEN_ENABLED', 'ALLOWED_ORIGINS',
]);
requireTokens('src/worker.js', [
  'export const roleMap', '"worker-sms"', '"worker-automation"',
  '"worker-lifecycle"', '"worker-a2p"', 'startSmsProcessingWorker',
  'startWebhookWorkWorker', 'startAutomationWorker',
  'startProcessHeartbeat', 'stopProcessHeartbeat',
]);
requireTokens('src/services/webhooks/webhookWork.service.js', [
  'crypto.createHash', '$setOnInsert', 'status: "queued"',
  'leaseToken: crypto.randomUUID()', 'status: "processing"',
]);
requireTokens('src/workers/webhookWork.worker.js', [
  'leaseToken: job.leaseToken', 'status: "completed"',
  'error.deliveryUncertain === true', 'createSystemAlert',
]);
requireTokens('src/workers/smsProcessing.worker.js', [
  'withDistributedLease', 'heartbeatInboundSmsJob',
  'completeInboundSmsJob', 'failInboundSmsJob', 'assertDistributedLeaseActive',
]);
requireTokens('src/services/scaleHealth.service.js', [
  'automationWorkerReady', 'missingRoles', 'recoveryOldestAgeMs',
  'appointmentNoticeOldestAgeMs',
]);
requireTokens('src/controllers/auth/context.js', ['httpOnly: true']);
requireTokens('src/controllers/auth/Registration.js', ['res.cookie("token", token, cookieOptions)']);
requireTokens('src/controllers/auth/Session.js', [
  'res.cookie("token", token, cookieOptions)', 'res.clearCookie("token", clearCookieOptions)',
]);
requireTokens('scripts/audit-repository-hygiene.mjs', [
  'isSafeMongoFixture', 'possible_secret', 'trackedFiles',
]);
requireTokens('.github/workflows/ci.yml', [
  'node scripts/meekcall-architecture-contracts.mjs',
  'npm run release:certify:ci',
]);
requireTokens('.github/workflows/browser-workflows.yml', [
  "vars.CALLBACKIQ_FRONTEND_REF || 'main'",
  'CALLBACKIQ_CROSS_REPO_READ_TOKEN',
  'Checkout partner repository', 'github.token',
]);
requireBefore('.github/workflows/browser-workflows.yml',
  'Checkout partner repository',
  'Record exact API and frontend revisions');

if (failures.length) {
  console.error(`FAIL MeekCall API architecture contracts (${failures.length} findings, ${checks} checks):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PASS MeekCall API architecture contracts (${checks} static checks).`);
}
console.log('NOTE: Static contract checks cannot prove live service reliability or production readiness.');
