import { freshObservation } from '../src/config/scaleCapacityPlan.js';
export function validateOperationalEvidence(report, { now = Date.now() } = {}) {
  const errors = [];
  const start = Date.parse(report.startedAt), end = Date.parse(report.endedAt);
  if (!freshObservation(report.endedAt, now) || !Number.isFinite(start) || !(end > start) ||
      Math.abs(end - start - report.durationMs) > 5000) errors.push('measured_work_interval');
  if (!['live', 'simulated'].includes(report.providerMode) || !/^[a-f0-9]{64}$/.test(report.capacityPlanSha256 || '')) errors.push('capacity_plan_identity');
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(report.imageDigest || '')) errors.push('immutable_image_identity');
  if (report.failures !== 0 || report.sms?.failures !== 0 || report.fleetSampleFailures !== 0) errors.push('missing_or_failed_counters');
  for (const key of ['missing', 'incomplete', 'wrongTenant', 'duplicateReplies', 'uncertain']) {
    if (report.outcomes?.[key] !== 0) errors.push(`outcome_counter:${key}`);
  }
  for (const key of ['harnessFailures', 'aiTurnFailures', 'unexpectedEnds']) {
    if (report.voice?.[key] !== 0) errors.push(`voice_counter:${key}`);
  }
  const rows = report.fleetSamples;
  if (!Array.isArray(rows) || rows.length < Math.floor(report.durationMs / 10000)) return [...errors, 'fleet_sample_coverage'];
  let last = start;
  for (const row of rows) {
    const at = Date.parse(row.observedAt), timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at < last || at - last > 15000 || at > end + 5000 || !Number.isFinite(timestamp) || Math.abs(at - timestamp) > 15000) errors.push('fleet_sample_gap_or_staleness');
    last = at;
    if (row.healthy !== true || row.releases?.length !== 1 || row.releases[0] !== report.apiSha ||
        row.capacityPlans?.length !== 1 || row.capacityPlans[0] !== report.capacityPlanSha256 ||
        row.images?.length !== 1 || row.images[0] !== report.imageDigest) errors.push('fleet_health_or_identity');
    for (const [key, max] of [['smsOldestAgeMs', 10000], ['recoveryOldestAgeMs', 30000], ['failedPages', 0], ['uncertainEmail', 0]]) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > max) errors.push(`fleet_budget:${key}`);
    }
  }
  if (end - last > 15000) errors.push('fleet_sample_tail_gap');
  return [...new Set(errors)];
}
