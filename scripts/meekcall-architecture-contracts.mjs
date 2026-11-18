#!/usr/bin/env node
/**
 * MeekCall offline architecture contract checks.
 * Read-only. Cannot certify live Twilio, MongoDB, Redis, cookies, or workers.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';
import {validatePlan} from './check.mjs';

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
try {
  const workflow=yaml.safeLoad(source('.github/workflows/ci.yml'));
  const plan=JSON.parse(source('config/check-plan.json'));
  validatePlan(JSON.parse(source('package.json')).name,plan,JSON.parse(source('config/legacy-check-aliases.json')));
  checks+=4;
  if(!workflow.jobs.release.steps.some(step=>/^npm run verify(?:\s|$)/.test(step.run || '')))
    failures.push('CI does not invoke the authoritative release profile');
  for(const required of ['architecture:invariants','test:hardening','build:certification'])
    if(!plan.gates.some(gate=>gate.steps.includes(required)))failures.push(`Release profile omits ${required}`);
} catch(error){failures.push(`Invalid release wiring: ${error.message}`);}
requireTokens('.github/workflows/browser-workflows.yml', [
  "inputs.partner_ref || vars.CALLBACKIQ_FRONTEND_REF",
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
