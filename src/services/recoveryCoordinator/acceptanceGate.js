import crypto from 'node:crypto';
import RecoveryCase from '../../models/recoveryCase.js';
import {contractError} from './contract.js';
export const fingerprintRequest = value => crypto.createHash('sha256').update(JSON.stringify({request:String(value||'').trim()})).digest('hex');
// Staged gate only applies to cases explicitly initialized for this tenant;
// legacy customers retain their existing safety boundary during migration.
export async function assertRecoveryCaseAcceptance({businessId,leadId,conversationId,serviceOfferingId,actualRequest}) {
  const piloted = String(process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS || '').split(',').map(s=>s.trim()).includes(String(businessId));
  if (process.env.MEEKCALL_RECOVERY_REQUIRE_SERVICE_DECISION !== 'true' || !piloted || (!conversationId && !leadId)) return;
  if (!conversationId) {
    // For pilot leads, a lead-only booking cannot avoid a recorded decision.
    const existing = await RecoveryCase.exists({business:businessId,lead:leadId});
    if (existing) throw contractError('Select the linked customer conversation before booking.', 'RECOVERY_CONVERSATION_REQUIRED', 409);
    return;
  }
  const record = await RecoveryCase.findOne({business:businessId,conversation:conversationId,
    ...(leadId?{lead:leadId}:{})}).sort({generation:-1}).select('status facts serviceDecision').lean();
  if (!record) return; // No implicit migration of existing customer workflows.
  const decision = record.serviceDecision;
  if (decision?.decision !== 'accepted' || String(decision.serviceOfferingId||'')!==String(serviceOfferingId||'') ||
    record.status !== 'accepted' || decision.requestFingerprint !== fingerprintRequest(actualRequest) ||
    String(record.facts?.serviceNeeded||'').trim()!==String(actualRequest||'').trim()) {
    throw contractError('The current customer request has not been accepted for this service offering.', 'RECOVERY_SERVICE_ACCEPTANCE_REQUIRED', 409);
  }
}
