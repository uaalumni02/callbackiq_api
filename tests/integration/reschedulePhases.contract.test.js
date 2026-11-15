import mongoose from 'mongoose';
import Appointment from '../../src/models/appointment.js';
import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import SchedulingPolicy from '../../src/models/schedulingPolicy.js';
import Lead from '../../src/models/lead.js';
import { confirmReplacement } from '../../src/services/scheduling/reschedule/finalize.js';
import { followUp } from '../../src/services/scheduling/reschedule/followUp.js';
import { recoverReschedule } from '../../src/services/scheduling/reschedule/recovery.js';
import { lifecycleMarker, repairAppointmentLifecycle } from '../../src/services/scheduling/appointmentLifecycle.service.js';
import { cancelAppointmentNotifications, scheduleAppointmentReminders } from '../../src/services/scheduling/appointmentNotification.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';

jest.setTimeout(60000);
beforeAll(connectTestDB);afterEach(clearTestDB);afterAll(closeTestDB);
async function fixture() {
  const business = { _id: new mongoose.Types.ObjectId(), businessName: 'Synthetic phase contract', timezone: 'America/New_York' };
  const common = { business: business._id, serviceOffering: new mongoose.Types.ObjectId(), customerPhone: '+14045550100',
    startAt: new Date(Date.now() + 7 * 86400000), endAt: new Date(Date.now() + 7 * 86400000 + 3600000) };
  const original = await Appointment.create({ ...common, status: 'confirmed', idempotencyKey: 'original' });
  const replacement = await Appointment.create({ ...common, status: 'held', idempotencyKey: 'replacement',
    rescheduledFrom: original._id, pendingRescheduleExternalAppointmentId: 'event-1' });
  return { business, original, replacement };
}

test('[reschedule-pins] replacement finalization cannot overwrite a newer decision', async () => {
  const { replacement } = await fixture();
  await Appointment.updateOne({ _id: replacement._id }, { $set: { status: 'canceled' } });
  await expect(confirmReplacement({ replacement, receipt: { provider: 'internal', externalAppointmentId: 'event-1', externalCalendarId: null } },
    { lifecycleMarker })).rejects.toMatchObject({ name: 'DocumentNotFoundError' });
  expect((await Appointment.findById(replacement._id)).status).toBe('canceled');
});

test('[reschedule-pins] repeated follow-up preserves sent reminder and change-notice receipts', async () => {
  const f = await fixture();
  f.replacement.status = 'confirmed';f.replacement.lifecycleNotice = lifecycleMarker('rescheduled');
  await f.replacement.save();
  f.original.status = 'rescheduled';f.original.rescheduledTo = f.replacement._id;await f.original.save();
  await SchedulingPolicy.create({ business: f.business._id, customerRemindersEnabled: true, reminderHours: [2] });
  const dependencies = { Lead, cancelAppointmentNotifications, scheduleAppointmentReminders,
    tryRepairAppointmentLifecycle: repairAppointmentLifecycle, runNonBlockingAppointmentSideEffect: ({ task }) => task(),
    SocketService: { emitToBusiness: jest.fn(), emitDashboardRefresh: jest.fn() } };
  await followUp(f, dependencies);
  await AppointmentNotificationJob.updateMany({ appointment: f.replacement._id }, {
    $set: { status: 'sent', sentAt: new Date(), providerMessageId: 'synthetic-receipt' },
  });
  await followUp(f, dependencies);
  const rows = await AppointmentNotificationJob.find({ appointment: f.replacement._id }).lean();
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.status === 'sent' && row.providerMessageId === 'synthetic-receipt')).toBe(true);
});

test('[reschedule-pins] uncertain read after a lost acknowledgement cannot demote a possible confirmation', async () => {
  const save = jest.fn();
  const replacement = { _id: 'replacement', status: 'confirmed', save };
  const error = Error('Acknowledgement lost');
  await recoverReschedule({ business: { _id: 'tenant' }, original: { _id: 'original' }, replacement,
    key: 'same-key', snapshot: { status: 'held' }, handoff: { applied: true, receipt: { externalAppointmentId: 'event-1' } }, error },
  { Appointment: { findOne: async () => { throw Error('Read unavailable'); } },
    InterventionService: { create: jest.fn(), integrationFailure: jest.fn() } });
  expect(replacement.status).toBe('confirmed');expect(save).not.toHaveBeenCalled();
  expect(error.code).toBe('RESCHEDULE_RECONCILIATION_REQUIRED');
});
