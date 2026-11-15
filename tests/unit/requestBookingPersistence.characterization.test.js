import { applyBookingStateTransition, bookingTransitionFields } from '../../src/services/booking/requestBookingState.js';
import { saveBookingTransition, applyBookingEvent } from '../../src/services/booking/bookingTurnState.repository.js';
import { assertVoiceTurnActive } from '../../src/services/voiceTurnContext.service.js';
import { assertDistributedLeaseActive, getDistributedLeaseWriteDeadline } from '../../src/services/distributedLease.service.js';

const mockEvents = [];
jest.mock('../../src/services/voiceTurnContext.service.js', () => ({ assertVoiceTurnActive: jest.fn() }));
jest.mock('../../src/services/distributedLease.service.js', () => ({
  assertDistributedLeaseActive: jest.fn(), getDistributedLeaseWriteDeadline: jest.fn(),
}));
beforeEach(() => {
  mockEvents.length = 0;jest.clearAllMocks();
  assertVoiceTurnActive.mockImplementation(() => mockEvents.push('voice'));
  assertDistributedLeaseActive.mockImplementation(() => mockEvents.push('lease'));
  getDistributedLeaseWriteDeadline.mockReturnValue(null);
});
function document() {
  return { bookingState: { status: 'awaiting_confirmation', expiresAt: new Date(Date.now() + 60000),
    appointment: null, selectedSlot: { startAt: 'start', endAt: 'end' }, offeredSlots: [] },
    sessionIdentity: { id: 'existing-session' },
    set(path, value) { mockEvents.push(`set:${path}`);this.bookingState[path.slice('bookingState.'.length)] = value; },
    markModified: jest.fn(),
    save: jest.fn(async function () { mockEvents.push('save');expect(this.sessionIdentity.id).toBe('existing-session'); }),
  };
}

test('[state-writer-pins] pure booking transitions keep mutation timing and allowed fields', () => {
  const row = document();
  applyBookingStateTransition(row, 'service_requested', { status: 'booked', unsupported: true });
  expect(row.bookingState.status).toBe('collecting_service');expect(row.bookingState.unsupported).toBeUndefined();
  expect(row.save).not.toHaveBeenCalled();
  expect(bookingTransitionFields('booking_confirmed', { appointment: 'appointment-1', status: 'failed' })).toEqual({
    'bookingState.status': 'booked', 'bookingState.expiresAt': null, 'bookingState.lastError': '', 'bookingState.appointment': 'appointment-1',
  });
  expect(() => bookingTransitionFields('not-a-transition')).toThrow('Unknown booking patch transition');
});

test('[state-writer-pins] saving retains guards, mutation, original session and save order', async () => {
  const row = document();
  await saveBookingTransition(row, 'service_requested');
  expect(mockEvents).toEqual(['voice','lease','set:bookingState.status','save','voice','lease']);
  expect(row.save).toHaveBeenCalledWith();
});

test('[state-writer-pins] a save failure propagates without post-save guard calls', async () => {
  const row = document(), failure = Error('Synthetic persistence failure');
  row.save.mockImplementation(async () => { mockEvents.push('save');throw failure; });
  await expect(saveBookingTransition(row, 'service_requested')).rejects.toBe(failure);
  expect(mockEvents).toEqual(['voice','lease','set:bookingState.status','save']);
});

test('[state-writer-pins] a stale voice turn cannot mutate or save booking state', async () => {
  const row = document(), failure = Error('Synthetic stale voice turn');
  assertVoiceTurnActive.mockImplementationOnce(() => { throw failure; });
  await expect(saveBookingTransition(row, 'service_requested')).rejects.toBe(failure);
  expect(row.bookingState.status).toBe('awaiting_confirmation');expect(row.save).not.toHaveBeenCalled();
});

test('[state-writer-pins] conditional confirmation preserves the prior predicate and restores it', async () => {
  const row = document(), prior = { 'legacy.version': 4 }, deadline = new Date(Date.now() + 10000);
  row.$where = prior;getDistributedLeaseWriteDeadline.mockReturnValue(deadline);
  row.save.mockImplementation(async function () {
    mockEvents.push('save');
    expect(this.$where.$and[0]).toBe(prior);
    expect(this.$where.$and[1]).toMatchObject({ business: 'tenant-1', 'bookingState.status': 'awaiting_confirmation',
      'bookingState.selectedSlot.startAt': 'start', 'bookingState.selectedSlot.endAt': 'end' });
    expect(this.$where.$and[1].$expr.$and[1]).toEqual({ $lt: ['$$NOW', deadline] });
  });
  const outcome = await applyBookingEvent(row, 'claim_confirmation', { businessId: 'tenant-1' });
  expect(outcome).toEqual({ type: 'submit_appointment', selectedSlot: row.bookingState.selectedSlot });
  expect(row.bookingState.status).toBe('booking');expect(row.$where).toBe(prior);
});

test('[state-writer-pins] a lost conditional claim translates the error and restores the prior predicate', async () => {
  const row = document(), prior = { 'legacy.version': 4 };row.$where = prior;
  row.save.mockRejectedValue(Object.assign(Error('Synthetic stale write'), { name: 'DocumentNotFoundError' }));
  await expect(applyBookingEvent(row, 'claim_confirmation', { businessId: 'tenant-1' })).rejects.toMatchObject({ code: 'BOOKING_STATE_CONFLICT' });
  expect(row.$where).toBe(prior);expect(assertDistributedLeaseActive).toHaveBeenCalledTimes(2);
});
