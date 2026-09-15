export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validateVoiceReport(report, { expected, turns, ai, minDurationMs = 0, p95Ms = 5000, p99Ms = 10000 } = {}) {
  const errors = [];
  if (report.accepted !== expected || report.activeAtTurnStart < expected) errors.push('admission_count');
  if (report.harnessFailures || report.aiTurnFailures || report.unexpectedEnds || report.fallbackReplies) errors.push('conversation_failures');
  if (ai && report.completedAiTurns !== expected * turns) errors.push('incomplete_turns');
  if (report.minimumActiveDuringWork < expected) errors.push('lost_concurrency');
  if (!(report.workDurationMs >= minDurationMs)) errors.push('insufficient_duration');
  if (ai && (!measured(report.aiTurnLatencyMs?.p95) || !measured(report.aiTurnLatencyMs?.p99) || !(report.aiTurnLatencyMs.p95 <= p95Ms) || !(report.aiTurnLatencyMs.p99 <= p99Ms))) errors.push('voice_latency');
  if (report.tenantMismatch) errors.push('tenant_mismatch');
  return errors;
}
// A JSON report that says "passed" is insufficient: validate measured fields.
export function validateMixedReport(r, { businesses = 1001, voice = 350, durationMs = 300000, smsRps = 200 } = {}) {
  const errors = [];
  if (!r || r.schemaVersion !== 2) return ['invalid_report'];
  if (!(r.tenants >= businesses) || !(r.minimumDashboards >= businesses)) errors.push('dashboard_concurrency');
  if (!(r.durationMs >= durationMs) || r.failures || !Array.isArray(r.childExitCodes) || r.childExitCodes.length < 4 || r.childExitCodes.some(x => x !== 0)) errors.push('workload_failed');
  if (!(r.dashboardP95Ms > 0 && r.dashboardP95Ms <= 1000)) errors.push('dashboard_latency');
  if (!r.voice || r.voice.accepted < voice || !Array.isArray(r.voice.acceptanceErrors) || r.voice.acceptanceErrors.length ||
      !(r.voice.aiTurnsPerAcceptedClient >= 20) || validateVoiceReport(r.voice, { expected: r.voice.accepted, turns: r.voice.aiTurnsPerAcceptedClient,
        ai: true, minDurationMs: durationMs }).length) errors.push('voice_acceptance');
  if (!(r.sms?.requestsPerSecond >= smsRps * .95) || r.sms?.failures || !(r.sms?.latencyMs?.p95 <= 500) || !(r.sms?.latencyMs?.p99 <= 1000)) errors.push('sms_ingress');
  if (!(r.sms?.requests >= Math.floor(durationMs / 1000) * smsRps)) errors.push('sms_volume');
  if (!r.outcomes || r.outcomes.missing || r.outcomes.wrongTenant || r.outcomes.incomplete || r.outcomes.duplicateReplies || r.outcomes.uncertain || r.outcomes.checked !== r.sms?.requests) errors.push('sms_outcomes');
  if (!measured(r.outcomes?.providerAcceptanceP95Ms) || !(r.outcomes.providerAcceptanceP95Ms <= 10000)) errors.push('sms_acceptance_latency');
  return errors;
}
