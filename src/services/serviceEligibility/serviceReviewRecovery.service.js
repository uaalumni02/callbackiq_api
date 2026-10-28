import crypto from 'node:crypto';
import Conversation from '../../models/conversation.js';
import Alert from '../../models/alert.js';
import AlertService from '../alert.service.js';
import { staffReviewDueAt } from '../staffReviewPolicy.service.js';

// Bounded, read-before-write repair for historical service-review gaps.
// Maintenance worker only. Never schedules work, texts a customer, changes
// service eligibility, or reopens a review explicitly resolved by staff.
export const serviceReviewKey = (conversationId, request) =>
  `service-eligibility:${conversationId}:${crypto.createHash('sha256').update(String(request)).digest('hex').slice(0, 32)}`;

export const serviceReviewNeedsRepair = conversation => {
  const state = conversation?.serviceEligibility;
  const intake = conversation?.conversationMemory?.recoveryIntake || {};
  return Boolean(conversation?.status === 'open' && conversation?.business && conversation?.lead &&
    state?.decision === 'needs_staff_review' && state.reviewSubmitted === true &&
    state.reviewDeclined !== true && String(state.request || '').trim() &&
    !intake.withdrawnAt && !conversation.bookingState?.appointment &&
    conversation.bookingState?.status !== 'booked');
};

export async function reconcileServiceReviewPage({ after = null, limit = 25 } = {}) {
  const size = Math.max(1, Math.min(50, Number(limit) || 25));
  const filter = {
    status: 'open',
    'serviceEligibility.decision': 'needs_staff_review',
    'serviceEligibility.reviewSubmitted': true,
    ...(after ? { _id: { $gt: after } } : {}),
  };
  const records = await Conversation.find(filter)
    .sort({ _id: 1 }).limit(size)
    .select('_id business lead status serviceEligibility bookingState conversationMemory')
    .lean();
  let created = 0;
  let skipped = 0;
  for (const row of records) {
    if (!serviceReviewNeedsRepair(row)) { skipped++; continue; }
    const request = String(row.serviceEligibility.request).trim();
    const dedupeKey = serviceReviewKey(row._id, request);
    // Any existing record (including resolved) is intentional history.
    // Do not restore a previously declined/handled review on a timer.
    if (await Alert.exists({ business: row.business, dedupeKey })) { skipped++; continue; }
    const result = await AlertService.create({
      businessId: row.business, leadId: row.lead, conversationId: row._id,
      type: 'system', actionRequired: true, channel: 'in_app',
      priority: 'medium', dueAt: staffReviewDueAt('medium'),
      title: 'Service eligibility needs review',
      reason: String(row.serviceEligibility.reason || 'service_acceptance_pending'),
      message: `Review the requested work: ${request.slice(0, 300)}. Confirm whether the business accepts the service before scheduling. No appointment is confirmed.`,
      recommendedAction: 'Verify the actual request against configured service offerings, correct facts if needed, and check availability before booking.',
      metadata: {
        leadId: String(row.lead), conversationId: String(row._id),
        serviceEligibilityReason: String(row.serviceEligibility.reason || 'service_acceptance_pending'),
        repairSource: 'missing_staff_review',
      },
      dedupeKey,
    });
    if (!result?.alert?._id) throw new Error('Failed to persist repaired service eligibility review');
    if (result.created) created++;
  }
  return {
    scanned: records.length, created, skipped,
    nextCursor: records.length === size ? String(records.at(-1)._id) : null,
  };
}
