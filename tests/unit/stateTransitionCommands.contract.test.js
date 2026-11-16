import { saveStateDocument, saveOptionalStateDocument } from '../../src/services/stateTransitions/documents.js';
import { persistReviewedLeadName, persistReviewedConversationName } from '../../src/services/stateTransitions/requestIntake.js';
import { beginConfirmationIntent, claimDueConfirmationIntent } from '../../src/services/stateTransitions/appointmentLifecycle.js';
import { advanceRecoveryDecision } from '../../src/services/stateTransitions/recoveryCoordinator.js';
import { updateSmsSnapshotBatch } from '../../src/services/stateTransitions/messaging.js';

test('document persistence retains the native receiver, arguments and promise identity', async () => {
  const result = Promise.resolve({ saved: true });
  const session = {};
  const options = { session, validateBeforeSave: true };
  const document = { save: jest.fn(function (received) { expect(this).toBe(document); expect(received).toBe(options); return result; }) };
  expect(saveStateDocument(document, options)).toBe(result);
  expect(document.save).toHaveBeenCalledTimes(1);
  await result;
});

test('optional persistence keeps the legacy no-save result and does not suppress failures', async () => {
  expect(saveOptionalStateDocument({})).toBeUndefined();
  const failure = new Error('save failed');
  expect(() => saveStateDocument({ save() { throw failure; } })).toThrow(failure);
  const rejected = Promise.reject(failure);
  expect(saveOptionalStateDocument({ save: () => rejected })).toBe(rejected);
  await expect(rejected).rejects.toBe(failure);
});

test.each([
  ['lead', persistReviewedLeadName, 'Lead'],
  ['conversation', persistReviewedConversationName, 'Conversation'],
])('reviewed %s names keep their tenant and observed-name compare-and-set', (key, command, modelName) => {
  const result = { matchedCount: 0 };
  const model = { updateOne: jest.fn(() => result) };
  const row = { _id: 'record-a', customerName: 'reviewed name' };
  expect(command({ [modelName]: model, [key]: row, business: { _id: 'tenant-a' }, customerName: 'new name' })).toBe(result);
  expect(model.updateOne).toHaveBeenCalledWith(
    { _id: 'record-a', business: 'tenant-a', customerName: 'reviewed name' },
    { $set: { customerName: 'new name' } },
  );
});

test('starting confirmation preserves held/expiry/version fencing and the lazy native query', () => {
  const query = { select: jest.fn() };
  const Appointment = { findOneAndUpdate: jest.fn(() => query) };
  const now = new Date('2026-11-15T17:00:00Z');
  const options = { writeConcern: { w: 'majority' } };
  const appointment = { _id: 'a', business: 'tenant-a', updatedAt: now };
  expect(beginConfirmationIntent({ Appointment, appointment, approvedBy: 'staff-a',
    lease: () => ({ token: 'claim-a' }), now, options, provider: 'internal',
    slotIdentity: row => ({ _id: row._id, business: row.business }),
  })).toBe(query);
  expect(Appointment.findOneAndUpdate).toHaveBeenCalledWith({
    _id: 'a', business: 'tenant-a', status: 'held',
    $or: [{ heldExpiresAt: null }, { heldExpiresAt: { $gt: now } }],
    'confirmationIntent.status': { $ne: 'pending_provider' }, updatedAt: now,
  }, { $set: { confirmationIntent: {
    key: 'tenant-a:a', status: 'pending_provider', requestedAt: now, nextAttemptAt: now,
    approvedBy: 'staff-a', provider: 'internal', attempts: 0, token: 'claim-a',
  } } }, options);
  expect(query.select).not.toHaveBeenCalled();
});

test('confirmation recovery keeps its observed state and due-claim fence', () => {
  const Appointment = { findOneAndUpdate: jest.fn() };
  const now = new Date();
  const appointment = { _id: 'a', business: 'tenant-a', status: 'held', confirmationIntent: { status: 'pending_provider' } };
  claimDueConfirmationIntent({ Appointment, appointment, now, due: at => ({ 'confirmationIntent.leaseUntil': { $lte: at } }),
    token: 'new-token', leaseUntil: now, options: {}, slotIdentity: row => ({ _id: row._id, business: row.business }) });
  expect(Appointment.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'a', business: 'tenant-a', status: 'held',
    'confirmationIntent.status': 'pending_provider', 'confirmationIntent.leaseUntil': { $lte: now } });
});

test('recovery decisions preserve tenant/version CAS and the transaction session', () => {
  const session = {};
  const RecoveryCase = { findOneAndUpdate: jest.fn() };
  advanceRecoveryDecision({ RecoveryCase, businessId: 'tenant-a', next: { status: 'accepted' }, record: { _id: 'case-a' }, session, version: 7 });
  expect(RecoveryCase.findOneAndUpdate).toHaveBeenCalledWith(
    { _id: 'case-a', business: 'tenant-a', version: 7 },
    { $set: { status: 'accepted' }, $inc: { version: 1 } }, { new: true, runValidators: true, session },
  );
});

test('snapshot batching keeps every row tenant predicate and unordered partial-write semantics', () => {
  const Conversation = { bulkWrite: jest.fn() };
  const filter = { _id: 'c-a', business: 'tenant-a' };
  const updates = [{ lastMessage: 'message-a' }];
  updateSmsSnapshotBatch({ Conversation, rows: [{ filter }], updates });
  expect(Conversation.bulkWrite).toHaveBeenCalledWith([{ updateOne: { filter, update: { $set: updates[0] } } }], { ordered: false });
});
