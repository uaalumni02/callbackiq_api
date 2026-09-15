import fs from 'node:fs/promises';
import path from 'node:path';
import { validateMixedReport } from '../perf/acceptance.mjs';
const root = path.resolve(process.env.SCALE_EVIDENCE_DIR || 'scale-evidence');
const evidence = JSON.parse(await fs.readFile(path.join(root, 'acceptance.json'), 'utf8'));
const errors = [];
for (const key of ['apiSha', 'uiSha']) if (!/^[a-f0-9]{40}$/.test(evidence[key] || '')) errors.push(`Missing ${key}`);
const files = evidence.mixedReports;
if (!Array.isArray(files) || !files.length) errors.push('Missing measured mixed-load reports');
let testedMs = 0;
const runIds = new Set();
for (const name of files || []) {
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep)) throw new Error('Evidence must be inside the evidence directory');
  const r = JSON.parse(await fs.readFile(full, 'utf8'));
  if (!r.runId || runIds.has(r.runId)) errors.push(`${name}: missing or duplicate run ID`);
  runIds.add(r.runId);
  if (r.apiSha !== evidence.apiSha || r.uiSha !== evidence.uiSha) errors.push('Report release mismatch');
  errors.push(...validateMixedReport(r).map(x => `${name}: ${x}`));
  testedMs += Number(r.durationMs) || 0;
}
if (testedMs < 3600000) errors.push('At least 60 minutes of passing mixed cohorts required');
const required = ['continuousLiveSoak', 'burst350', 'workerKillFinalAttempt', 'voiceGracefulDrain', 'voiceAbruptFailure', 'redisOutage', 'mongoFailover',
  'provider429AndTimeout', 'webhookReplay', 'crossTenantAccess', 'ownerEmailAndOpsPaging', 'noStaffResponse',
  'realHandsetVoiceAndSms', 'realCalendarApprovalRescheduleCancel', 'realBillingTrialAndExpired', 'realMobileLogin', 'backupRestore', 'ingressWebsocketAndProxy', 'providerQuotaReview'];
for (const name of required) {
  const item = evidence.checks?.[name];
  const when = Date.parse(item?.observedAt);
  if (item?.passed !== true || !Number.isFinite(when) || when > Date.now() + 300000 || Date.now() - when > 14 * 86400000 || !item?.evidenceRef || !item?.observedBy) errors.push(`Missing or stale observation: ${name}`);
}
if (!evidence.infrastructure?.imageDigest || !evidence.infrastructure?.topologyRef || !evidence.infrastructure?.providerQuotaRef) errors.push('Missing infrastructure/provider references');
console.log(JSON.stringify({ passed: errors.length === 0, errors, testedMinutes: testedMs / 60000,
  note: 'Observation references require reviewer verification. This checks evidence completeness and measured fields; it cannot authenticate manually entered observations.' }, null, 2));
if (errors.length) process.exitCode = 1;
