import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { preservePendingApprovalOnAvailabilityConflict } from '../src/services/scheduling/approvalAvailabilityFailurePolicy.js';

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/services/scheduling/appointment.service.js'), 'utf8');

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
  const start = source.indexOf('if (!stillAvailable) {', source.indexOf('static async confirm('));
  const end = source.indexOf('const [service, lead]', start);
  assert.ok(start > 0 && end > start, 'expected bounded final availability branch');
  const branch = source.slice(start, end);
  assert.match(branch, /preservePendingApprovalOnAvailabilityConflict\(appointment\)/);
  assert.ok(branch.indexOf('preservePendingApprovalOnAvailabilityConflict(appointment)') < branch.indexOf('appointment.status = "failed"'), 'preservation must occur before failure persistence');
  assert.match(branch, /SLOT_UNAVAILABLE/);
});

test('expired holds still have the existing reconciliation mechanism', () => {
  assert.match(source, /static async releaseExpiredHolds\(/);
  assert.match(source, /await reconcileApprovalRequests\(\{ businessId \}\)/);
  assert.match(source, /static async recheckAndConfirm\(/);
});
