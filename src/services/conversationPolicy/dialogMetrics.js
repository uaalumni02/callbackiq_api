// Redacted event telemetry. Do not log phone, address, transcript, names, or raw customer text.
import { logOperationalEvent } from '../../helpers/logging/safeLogger.js';
const categories = new Set(['handled','observed','deferred','semantic_unavailable','loop_risk','guard_veto']);
export function emitDialogMetric({ businessId = null, conversationId = null, channel = 'sms', outcome = 'deferred',
  intent = 'unknown', phase = 'unknown', durationMs = null } = {}) {
  const safeOutcome = categories.has(outcome) ? outcome : 'deferred';
  try {
    logOperationalEvent('meekcall.conversation_policy_v3', {
      businessId, conversationId, channel: channel === 'voice' ? 'voice' : 'sms',
      outcome: safeOutcome, intent: String(intent).slice(0,50), phase: String(phase).slice(0,50),
      ...(Number.isFinite(durationMs) ? { durationMs: Math.round(durationMs) } : {}), version: 3,
    });
  } catch { /* Observability must never break a customer turn. */ }
}
