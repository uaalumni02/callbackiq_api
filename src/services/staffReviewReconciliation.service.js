import { requestReviewKey } from './requestReview.service.js';
import { logOperationalError } from '../helpers/logging/safeLogger.js';
import crypto from 'node:crypto';
import Conversation from '../models/conversation.js';
import Alert from '../models/alert.js';
import Message from '../models/message.js';
import AlertService from './alert.service.js';
import { withDistributedLease, assertDistributedLeaseActive } from './distributedLease.service.js';
import { queryBudgetMs } from './scale/queryBudget.js';

// A recovery pass creates staff work only. It never sends a customer message,
// confirms an appointment, clears a review, or overwrites newer intake facts.
export const needsStaffReviewRecovery = conversation => {
  const intake = conversation?.conversationMemory?.recoveryIntake || {};
  if (conversation?.status !== 'open' || intake.withdrawnAt || intake.reviewAppointmentId ||
      conversation.bookingState?.appointment || conversation.bookingState?.status === 'booked') return false;
  if (intake.journeyKey !== undefined && intake.journeyKey !== (conversation.orchestration?.recoveryJourneyKey || '')) return false;
  if (['resolved', 'completed', 'canceled', 'cancelled'].includes(intake.review?.status)) return false;
  return Boolean(intake.reviewReady || intake.submitted ||
    ['pending_persistence', 'queued', 'update_required'].includes(intake.review?.status) ||
    conversation.orchestration?.handoffReason);
};

export const reviewRecoveryKey = conversation => {
  const state = conversation.conversationMemory?.recoveryIntake || {};
  const evidence = [String(conversation._id), conversation.orchestration?.recoveryJourneyKey || '',
    String(conversation.orchestration?.handoffInboundMessage || ''), state.review?.evidenceKey || '',
    state.serviceNeeded || '', state.address || '', state.preferredAppointmentTime || ''];
  return `staff_review_recovery:${crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
};

export async function reconcileConversationStaffReview({ conversationId, businessId, apply = false }) {
  const run = async () => {
    const conversation = await Conversation.findOne({ _id: conversationId, business: businessId }).maxTimeMS(queryBudgetMs()).lean();
    if (!needsStaffReviewRecovery(conversation)) return { status: 'not_required' };
    const intake = conversation.conversationMemory?.recoveryIntake || {};
    const key = reviewRecoveryKey(conversation);
    const inboundId = conversation.orchestration?.handoffInboundMessage;
    const inbound = inboundId ? await Message.findOne({ _id: inboundId, business: businessId, conversation: conversationId })
      .select('_id providerMessageId').maxTimeMS(queryBudgetMs()).lean() : null;
    const originalKey = inbound ? `human_handoff:${inbound.providerMessageId || inbound._id}` : null;
    const matches = [{ dedupeKey: requestReviewKey(conversation._id, conversation.orchestration?.recoveryJourneyKey) }, { dedupeKey: key }, { actionRequired: true, resolvedAt: null }];
    if (intake.review?.alertId) matches.push({ _id: intake.review.alertId });
    if (originalKey) matches.push({ dedupeKey: originalKey });
    if (!inboundId && !conversation.orchestration?.handoffRequestedAt && !intake.review?.alertId) {
      // Legacy/voice records may have no message ID. Without a reliable request
      // generation, preserve a prior staff resolution instead of reopening it.
      matches.push({ actionRequired: true, type: { $in: ['human_requested', 'safety_emergency', 'integration_failure'] },
        ...(intake.journeyKey ? { 'metadata.intakeReview.journeyKey': intake.journeyKey } : {}) });
    }
    // An already resolved review for this request counts as handled: never reopen it.
    if (conversation.orchestration?.handoffRequestedAt) matches.push({
      actionRequired: true, createdAt: { $gte: new Date(conversation.orchestration.handoffRequestedAt) },
    });
    const existing = await Alert.findOne({ business: businessId, conversation: conversationId, $or: matches })
      .select('_id resolvedAt').maxTimeMS(queryBudgetMs()).lean();
    if (existing) return { status: existing.resolvedAt ? 'handled' : 'present', alertId: String(existing._id) };
    if (!apply) return { status: 'missing', conversationId: String(conversationId) };
    assertDistributedLeaseActive();
    const saved = await AlertService.create({ businessId, conversationId, leadId: conversation.lead,
      type: 'integration_failure', priority: 'high', actionRequired: true, dedupeKey: originalKey || key,
      title: 'Customer request needs staff review',
      message: 'A saved customer request had no matching staff-review record. Review the transcript and current request before responding.',
      reason: 'staff_review_record_recovered',
      recommendedAction: 'Take ownership, review the latest messages, and verify service coverage and availability. No appointment has been confirmed by this recovery.',
      metadata: { recoveredReview: true, recoveryKey: key, handoffReason: conversation.orchestration?.handoffReason || '',
        serviceNeeded: intake.serviceNeeded || '', address: intake.address || '',
        preferredAppointmentTime: intake.preferredAppointmentTime || '', externalNotificationEligible: true },
    });
    if (!saved?.alert?._id) throw new Error('Recovered staff review was not persisted');
    return { status: saved.created === false ? 'present' : 'recovered', alertId: String(saved.alert._id) };
  };
  if (!apply) return run();
  // Same key as the SMS worker: no duplicate recovery while an intake turn is running.
  const lease = await withDistributedLease(`sms-conversation:${conversationId}`, run, { ttlMs: 30000 });
  return lease.acquired ? lease.value : { status: 'busy' };
}

export async function reconcileStaffReviewPage({ businessId, after = null, limit = 50, apply = false, now = new Date() } = {}) {
  const size = Math.max(1, Math.min(250, Number(limit) || 50));
  const rows = await Conversation.find({ status: 'open', ...(businessId ? { business: businessId } : {}),
    ...(after ? { _id: { $gt: after } } : {}), updatedAt: { $lte: new Date(now.getTime() - 60000) },
    $or: [{ 'conversationMemory.recoveryIntake.reviewReady': true }, { 'conversationMemory.recoveryIntake.submitted': true },
      { 'conversationMemory.recoveryIntake.review.status': { $in: ['pending_persistence', 'queued', 'update_required'] } },
      { 'orchestration.handoffReason': { $exists: true, $nin: ['', null] } }],
  }).sort({ _id: 1 }).limit(size).select('_id business').maxTimeMS(queryBudgetMs()).lean();
  const results = [];
  for (const row of rows) {
    try { results.push(await reconcileConversationStaffReview({ conversationId: row._id, businessId: row.business, apply })); }
    catch (error) {
      logOperationalError('staff_review.reconciliation_failed', error, { businessId: row.business, conversationId: row._id });
      results.push({ status: 'failed' });
    }
  }
  return { scanned: rows.length, nextCursor: rows.length === size ? String(rows.at(-1)._id) : null, results };
}

let cursor = null;
let nextRunAt = 0;
let running = false;
export async function maintainStaffReviewRecords({ now = new Date() } = {}) {
  if (running || now.getTime() < nextRunAt || process.env.STAFF_REVIEW_RECONCILIATION_ENABLED === 'false') return { skipped: true };
  running = true;
  try {
    const page = await reconcileStaffReviewPage({ after: cursor, limit: 50, apply: true, now });
    cursor = page.nextCursor;
    nextRunAt = now.getTime() + (cursor ? 5000 : 60000);
    return page;
  } finally { running = false; }
}
