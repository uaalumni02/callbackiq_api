import assert from 'node:assert/strict';
import test from 'node:test';
import {behavioralGuarantee,confirmationContracts} from './support/behavioralGuarantee.mjs';
import { preservePendingApprovalOnAvailabilityConflict } from '../src/services/scheduling/approvalAvailabilityFailurePolicy.js';
import { assertConfirmationNotPending } from '../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { createAppointmentconfirm1Methods } from '../src/services/scheduling/commands/confirm-1.js';

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

test('the production confirmation path preserves review before failed persistence',()=>behavioralGuarantee(confirmationContracts,/lost slot before any provider attempt|staff approval persists/));

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
    assertConfirmationNotPending, assertIntakeHoldCurrent: async () => {},
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

test('expired holds still have the existing reconciliation mechanism',()=>behavioralGuarantee(confirmationContracts,/pending intent prevents hold expiry|hold expiry retains tenant scope|failed persistence short-circuits/));
