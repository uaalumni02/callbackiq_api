import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateMixedReport } from './acceptance.mjs';
import { validateCapacityPlan, freshObservation } from '../src/config/scaleCapacityPlan.js';
export const REQUIRED_OBSERVATIONS = ['continuousLiveSoak', 'burst350', 'workerKillFinalAttempt', 'voiceGracefulDrain', 'voiceAbruptFailure', 'redisOutage', 'mongoFailover',
  'provider429AndTimeout', 'webhookReplay', 'crossTenantAccess', 'ownerEmailAndOpsPaging', 'noStaffResponse',
  'realHandsetVoiceAndSms', 'realCalendarApprovalRescheduleCancel', 'realBillingTrialAndExpired', 'realMobileLogin', 'backupRestore', 'ingressWebsocketAndProxy', 'providerQuotaReview', 'noisySmsTenant', 'largeHistoryQueries', 'coldCacheReplicaRefresh', 'smsWorkerSizing'];
export async function verifyScaleCertificate(root) {
  root = await fs.realpath(root);
  const evidence = JSON.parse(await fs.readFile(path.join(root, 'acceptance.json'), 'utf8'));
  const errors = [], intervals = [], runIds = new Set();
  if (evidence.schemaVersion !== 2) errors.push('Evidence schemaVersion must be 2');
  for (const key of ['apiSha', 'uiSha']) if (!/^[a-f0-9]{40}$/.test(evidence[key] || '')) errors.push(`Missing ${key}`);
  const readAttachment = async (item, json = true) => {
    if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw new Error('Attachment path and SHA-256 are required');
    const full = await fs.realpath(path.resolve(root, item.path));
    if (!full.startsWith(root + path.sep)) throw new Error('Attachment escapes evidence directory');
    const bytes = await fs.readFile(full);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Attachment checksum mismatch: ${item.path}`);
    return json ? JSON.parse(bytes) : bytes;
  };
  let plan;
  try {
    plan = await readAttachment(evidence.capacityPlan);
    errors.push(...validateCapacityPlan(plan, { apiSha: evidence.apiSha }).errors);
    if (plan.providerMode !== 'live') errors.push('Simulated capacity does not certify live-provider scale');
  } catch (e) { errors.push(`capacityPlan: ${e.message}`); }
  if (!Array.isArray(evidence.mixedReports) || !evidence.mixedReports.length) errors.push('Missing measured mixed-load reports');
  for (const item of evidence.mixedReports || []) {
    try {
      const r = await readAttachment(item);
      if (!r.runId || runIds.has(r.runId)) errors.push('Missing or duplicate run ID');
      runIds.add(r.runId);
      if (r.apiSha !== evidence.apiSha || r.uiSha !== evidence.uiSha || r.capacityPlanSha256 !== evidence.capacityPlan?.sha256 || r.imageDigest !== evidence.infrastructure?.imageDigest) errors.push('Report release/deployment mismatch');
      if (r.providerMode !== 'live') errors.push('Mixed report must use live-provider mode');
      errors.push(...validateMixedReport(r, { requireOwnerReads: true, requireOperationalEvidence: true }));
      intervals.push([Date.parse(r.startedAt), Date.parse(r.endedAt), Number(r.durationMs)]);
    } catch (e) { errors.push(`mixedReport: ${e.message}`); }
  }
  intervals.sort((a,b) => a[0] - b[0]);
  for (let i = 1; i < intervals.length; i++) if (intervals[i][0] < intervals[i - 1][1]) errors.push('Mixed intervals overlap; cannot double-count soak time');
  const testedMs = intervals.reduce((n,x) => n + (Number.isFinite(x[2]) ? x[2] : 0), 0);
  if (testedMs < 3600000) errors.push('At least 60 minutes of measured passing cohorts required');
  let largeHistory = false;
  if (!Array.isArray(evidence.queryReports) || evidence.queryReports.length < 2) errors.push('Supply typical and large-history query reports');
  for (const item of evidence.queryReports || []) {
    try {
      const r = await readAttachment(item);
      if (r.release !== evidence.apiSha || !freshObservation(r.observedAt)) errors.push('Query report release/freshness');
      if (r.counts?.leads >= 100000) largeHistory = true;
      for (const name of ['owner-workflow-summary', 'owner-status-summary', 'owner-page', 'lead-search-miss', 'customer-messages']) {
        const q = r.queries?.find(x => x.name === name);
        if (!q?.measured || !Array.isArray(q.plans) || !q.plans.length || !(q.elapsedMs >= 0 && q.elapsedMs <= 3000)) errors.push(`Query evidence missing/over budget: ${name}`);
      }
    } catch (e) { errors.push(`queryReport: ${e.message}`); }
  }
  if (!largeHistory) errors.push('Missing query evidence for a tenant with at least 100000 leads');
  for (const name of REQUIRED_OBSERVATIONS) {
    const item = evidence.checks?.[name];
    if (item?.passed !== true || !freshObservation(item?.observedAt) || !item?.observedBy || item.apiSha !== evidence.apiSha || item.uiSha !== evidence.uiSha) errors.push(`Missing/stale/release-mismatched observation: ${name}`);
    try { await readAttachment(item?.attachment, false); } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(evidence.infrastructure?.imageDigest || '')) errors.push('Missing immutable image digest');
  try { await readAttachment(evidence.infrastructure?.topology, false); } catch(e) { errors.push(`topology: ${e.message}`); }
  return { passed: errors.length === 0, errors: [...new Set(errors)], testedMinutes: testedMs / 60000,
    note: 'Hashes bind files, not their truth. A reviewer must verify observations, quotas, continuous soak, and infrastructure against the attached evidence.' };
}
