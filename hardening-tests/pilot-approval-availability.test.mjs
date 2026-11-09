import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { preservePendingApprovalOnAvailabilityConflict } from '../src/services/scheduling/approvalAvailabilityFailurePolicy.js';
import { assertConfirmationNotPending } from '../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { createAppointmentconfirm1Methods } from '../src/services/scheduling/commands/confirm-1.js';

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/services/scheduling/appointment.service.js'), 'utf8');
const confirmationSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/services/scheduling/commands/confirm-1.js'), 'utf8');
const expirySource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/services/scheduling/appointmentHoldExpiry.service.js'), 'utf8');

test('pending staff approval remains reviewable when a final slot check fails', () => {
  assert.equal(preservePendingApprovalOnAvailabilityConflict({ status: 'held', requiresBusinessApproval: true, approvalDecisionAt: null }), true);
  assert.equal(preservePendingApprovalOnAvailabilityConflict({ status: 'held', requiresBusinessApproval: true }), true);
});

test('automatic, staff-created, and decided appointments retain their original behavior', () => {
  for (const appointment of [
    { status: 'held', requiresBusinessApproval: false },
    { status: 'confirmed', requiresBusinessApproval: true },
    { status: 'failed', requiresBusinessApproval: true },
    { status: 'held', requiresBusinessApproval: true, approvalDecisionAt: new Date() },
    null,
  ]) assert.equal(preservePendingApprovalOnAvailabilityConflict(appointment), false);
});

test('the production confirmation path uses the guard before mutating failed status', () => {
  assert.ok(source.includes(
    '__meekcallGetAppointmentconfirm1Methods().confirm.apply(this, args)'
  ), 'facade must delegate to the extracted confirmation command');
  assert.ok(source.includes('createAppointmentconfirm1Methods({'),
    'extracted confirmation command must be wired');

  const start = confirmationSource.indexOf(
    'if (!stillAvailable) {',
    confirmationSource.indexOf('async confirm(')
  );
  const end = confirmationSource.indexOf(
    'const service = await ServiceOffering.findById', start
  );
  assert.ok(start > 0 && end > start,
    'expected bounded final availability branch');
  const branch = confirmationSource.slice(start, end);
  assert.match(branch, /preservePendingApprovalOnAvailabilityConflict\(appointment\)/);
  assert.ok(branch.indexOf('preservePendingApprovalOnAvailabilityConflict(appointment)') < branch.indexOf('appointment.status = "failed"'), 'preservation must occur before failure persistence');
  assert.match(branch, /SLOT_UNAVAILABLE/);
});

test('unavailable slot preserves pending approval without persistence', async () => {
  const events = [];
  const appointment = {
    _id: 'hold-1',
    status: 'held',
    requiresBusinessApproval: true,
    approvalDecisionAt: null,
    heldExpiresAt: new Date(Date.now() + 600000),
    bookedBy: 'staff',
    conversation: null,
    serviceOffering: 'service-1',
    startAt: new Date('2026-11-12T10:00:00Z'),
    endAt: new Date('2026-11-12T11:00:00Z'),
    async save() { events.push('save'); },
  };

  const methods = createAppointmentconfirm1Methods({
    assertConfirmationNotPending,
    getAppointmentForBusiness: async () => appointment,
    assertTransition: () => events.push('transition'),
    exactSlotAvailable: async () => {
      events.push('availability');
      return false;
    },
    preservePendingApprovalOnAvailabilityConflict: value => {
      events.push('preserve');
      return preservePendingApprovalOnAvailabilityConflict(value);
    },
  });

  await assert.rejects(
    () => methods.confirm({
      business: { _id: 'business-1' },
      appointmentId: 'hold-1',
      approvedBy: 'staff-1',
    }),
    error => error.code === 'SLOT_UNAVAILABLE' &&
      error.statusCode === 409
  );

  assert.deepEqual(events, [
    'transition', 'availability', 'preserve'
  ]);
  assert.equal(appointment.status, 'held');
  assert.equal(appointment.approvalDecisionAt, null);
});

test('expired holds still have the existing reconciliation mechanism', () => {
  assert.match(source, /static async releaseExpiredHolds\(/);
  // Release 9 delegates the original hold-expiry reconciliation to an extracted module.
  assert.match(source, /const releaseExpiredHolds = createExpiredHoldReconciler\(/);
  assert.match(source, /return releaseExpiredHolds\(businessId\);/);
  assert.match(expirySource, /await reconcileApprovalRequests\(\{ businessId \}\)/);
  assert.match(expirySource, /await repairPendingAppointmentLifecycles\(\{ businessId \}\)/);
  assert.match(expirySource, /await repairPendingAppointmentProjections\(\{ businessId \}\)/);
  assert.match(expirySource, /await repairRescheduleReviews\(\{ businessId \}\)/);
  assert.match(expirySource, /await reconcileAppointmentNoticeFailures\(\{ businessId \}\)/);
  assert.match(expirySource, /await runApprovalSms\(\)/);
  assert.match(source, /static async recheckAndConfirm\(/);
});
