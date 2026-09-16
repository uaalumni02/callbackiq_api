// Pure validation shared by deployment rendering and evidence verification.
// Measurements must come from dedicated staging. This validates declarations;
// it does not turn a simulated benchmark into live-provider acceptance.
export const freshObservation = (value, now = Date.now()) => {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now + 300000 && now - at <= 14 * 86400000;
};
export function validateCapacityPlan(plan, { apiSha, now = Date.now() } = {}) {
  const errors = [];
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (plan?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(plan?.apiSha || '') || (apiSha && plan.apiSha !== apiSha)) errors.push('capacity release identity');
  if (!['simulated', 'live'].includes(plan?.providerMode)) errors.push('explicit providerMode');
  if (!freshObservation(plan?.observedAt, now) || !plan?.observedBy || !plan?.evidenceRef) errors.push('fresh capacity measurement provenance');
  const target = plan?.target;
  if (![target?.businesses, target?.voiceSessions, target?.smsPerSecond].every(Number.isInteger)) errors.push('integer workload targets');
  if (!(target?.businesses >= 1001 && target?.voiceSessions >= 350 && target?.smsPerSecond >= 200)) errors.push('minimum mixed-load target');
  const samples = plan?.smsSamples;
  let worstMs = 0;
  for (const name of ['normal', 'slow-provider']) {
    const sample = Array.isArray(samples) && samples.find(x => x.scenario === name);
    if (!sample || !(sample.completedJobs >= 1000) || !(sample.durationMs >= 300000) || !positive(sample.processingP95Ms) || !sample.evidenceRef) errors.push(`measured SMS scenario: ${name}`);
    else worstMs = Math.max(worstMs, sample.processingP95Ms);
  }
  const demand = plan?.providerDemand, quota = plan?.providerQuota;
  for (const name of ['aiRequestsPerSms', 'aiTokensPerSms', 'voiceTurnsPerSecond', 'aiRequestsPerVoiceTurn', 'aiTokensPerVoiceTurn', 'smsSegmentsPerJob']) {
    if (!positive(demand?.[name])) errors.push(`providerDemand.${name}`);
  }
  for (const name of ['otherAiRequestsPerMinute', 'otherAiTokensPerMinute', 'otherAiConcurrent']) {
    if (!(typeof demand?.[name] === 'number' && Number.isFinite(demand[name]) && demand[name] >= 0)) errors.push(`providerDemand.${name} must explicitly budget other workers`);
  }
  for (const name of ['aiRequestsPerMinute', 'aiTokensPerMinute', 'smsSegmentsPerSecond', 'voiceSessions', 'aiConcurrent']) {
    if (!positive(quota?.[name])) errors.push(`providerQuota.${name}`);
  }
  if (!quota?.evidenceRef || !freshObservation(quota?.observedAt, now)) errors.push('fresh provider quota reference');
  const utilization = plan?.utilization;
  if (!(positive(utilization) && utilization <= .8)) errors.push('utilization must be > 0 and <= 0.8');
  const rps = target?.smsPerSecond;
  const required = {
    aiRequestsPerMinute: 60 * (rps * demand?.aiRequestsPerSms + demand?.voiceTurnsPerSecond * demand?.aiRequestsPerVoiceTurn) + demand?.otherAiRequestsPerMinute,
    aiTokensPerMinute: 60 * (rps * demand?.aiTokensPerSms + demand?.voiceTurnsPerSecond * demand?.aiTokensPerVoiceTurn) + demand?.otherAiTokensPerMinute,
    smsSegmentsPerSecond: rps * demand?.smsSegmentsPerJob,
  };
  for (const [name, value] of Object.entries(required)) if (!(value <= quota?.[name] * utilization)) errors.push(`combined provider budget: ${name}`);
  if (!(quota?.voiceSessions >= Math.max(450, target?.voiceSessions) && quota?.aiConcurrent >= Math.max(400, target?.voiceSessions))) errors.push('voice/AI fleet quota');
  const requiredReplicas = Math.ceil(rps * worstMs / 1000 / (25 * utilization)) + 1;
  return { errors, requiredReplicas, processingP95Ms: worstMs, providerDemand: required };
}
