import Appointment from '../../src/models/appointment.js';
import { createExpiredHoldReconciler } from '../../src/services/scheduling/appointmentHoldExpiry.service.js';
import { stabilizationSchedulingFixture } from '../setup/stabilizationSchedulingFixture.js';
import { deferred } from '../setup/stabilizationFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
beforeAll(connectTestDB); afterEach(clearTestDB); afterAll(closeTestDB);
test('competing cancel/reschedule and expiry/reschedule operations cannot mutate the provider or release an owned hold', async () => {
  const f = await stabilizationSchedulingFixture(), entered = deferred(), release = deferred();
  f.provider.cancelAppointment.mockImplementation(async () => { entered.resolve(); await release.promise; f.events.delete('event'); });
  const cancellation = f.cancel(); await entered.promise;
  try {
    expect((await Appointment.findById(f.original._id)).status).toBe('cancel_pending');
    await expect(f.run()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.provider.updateAppointment).not.toHaveBeenCalled();
  } finally { release.resolve(); await cancellation; }
  expect((await Appointment.findById(f.original._id)).status).toBe('canceled');

  await clearTestDB();
  const g = await stabilizationSchedulingFixture(), moved = deferred(), finish = deferred();
  const update = g.provider.updateAppointment.getMockImplementation();
  g.provider.updateAppointment.mockImplementation(async args => { await update(args); moved.resolve(); await finish.promise; return { provider: 'google_calendar', externalAppointmentId: 'event', externalCalendarId: 'calendar' }; });
  const rescheduling = g.run(); await moved.promise;
  const noop = async () => {};
  try {
    await expect(g.cancel()).rejects.toMatchObject({ statusCode: 409 });
    expect(g.provider.cancelAppointment).not.toHaveBeenCalled();
    await Appointment.updateOne({ business: g.business._id, idempotencyKey: 'same-key' }, { $set: { heldExpiresAt: new Date(Date.now() - 1000) } });
    const expire = createExpiredHoldReconciler({ Appointment, reconcileApprovalRequests: noop, repairPendingAppointmentLifecycles: noop,
      repairPendingAppointmentProjections: noop, repairRescheduleReviews: noop, reconcileAppointmentNoticeFailures: noop, runApprovalSms: noop });
    await expire(g.business._id);
    const held = await Appointment.findOne({ business: g.business._id, idempotencyKey: 'same-key' });
    expect(held.status).toBe('held'); expect(held.slotClaimKeys).toHaveLength(1);
  } finally { finish.resolve(); await rescheduling; }
  expect(await Appointment.countDocuments({ business: g.business._id, status: 'confirmed' })).toBe(1);
  expect(g.events.has('event')).toBe(true);
});
