import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Appointment from '../../src/models/appointment.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import SchedulingPolicy from '../../src/models/schedulingPolicy.js';
import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import { createAppointmentreschedule1Methods } from '../../src/services/scheduling/commands/reschedule-1.js';
import { lifecycleMarker, repairAppointmentLifecycle } from '../../src/services/scheduling/appointmentLifecycle.service.js';
import { scheduleAppointmentReminders, cancelAppointmentNotifications } from '../../src/services/scheduling/appointmentNotification.service.js';
import { assertTransition } from '../../src/services/scheduling/appointmentStatePolicy.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';

jest.setTimeout(60000);
beforeAll(connectTestDB);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);
const objectId = () => new mongoose.Types.ObjectId();

async function fixture() {
  const business = { _id: objectId(), businessName: 'Synthetic reschedule', timezone: 'America/New_York' };
  const service = { _id: objectId(), durationMinutes: 60 };
  const lead = await Lead.create({ business: business._id, customerName: 'Synthetic customer', serviceNeeded: 'Sink repair', phone: '+14045550100' });
  const conversation = await Conversation.create({ business: business._id, lead: lead._id, customerPhone: lead.phone });
  const startAt = new Date(Date.now() + 7 * 86400000), endAt = new Date(+startAt + 3600000);
  const original = await Appointment.create({ business: business._id, lead: lead._id, conversation: conversation._id,
    serviceOffering: service._id, customerPhone: lead.phone, status: 'confirmed', startAt, endAt,
    provider: 'google_calendar', externalAppointmentId: 'event-1', externalCalendarId: 'calendar-1', idempotencyKey: 'original',
    activeSlotKey: 'original-slot', slotClaimKeys: ['original-slot'], capacityLane: 1 });
  await Conversation.updateOne({ _id: conversation._id }, { $set: { 'bookingState.status': 'booked', 'bookingState.appointment': original._id } });
  await Lead.updateOne({ _id: lead._id }, { $set: { appointment: original._id } });
  await SchedulingPolicy.create({ business: business._id, customerRemindersEnabled: true, reminderHours: [2] });
  const providerEvents = new Map([['event-1', { startAt, endAt }]]);
  const provider = { updateAppointment: jest.fn(async ({ changes }) => {
    providerEvents.set('event-1', changes);
    return { provider: 'google_calendar', externalAppointmentId: 'event-1', externalCalendarId: 'calendar-1' };
  }) };
  const deps = {
    Appointment, Lead, crypto, assertTransition, lifecycleMarker, cancelAppointmentNotifications, scheduleAppointmentReminders,
    addMinutes: (date, minutes) => new Date(+new Date(date) + minutes * 60000), normalizeAddress: value => value,
    getAppointmentForBusiness: (businessId, id) => Appointment.findOne({ _id: id, business: businessId }),
    getBookableService: async () => service, exactSlotAvailable: async () => true,
    createHold: async ({ input, idempotencyKey }) => Appointment.create({ ...input, business: business._id,
      serviceOffering: input.serviceOfferingId, status: 'held', idempotencyKey, activeSlotKey: 'replacement-slot', slotClaimKeys: ['replacement-slot'], capacityLane: 1 }),
    SchedulingProviderFactory: { getProvider: () => provider },
    InterventionService: { create: jest.fn(), integrationFailure: jest.fn() },
    SocketService: { emitToBusiness: jest.fn(), emitDashboardRefresh: jest.fn() },
    runNonBlockingAppointmentSideEffect: async ({ task }) => task(),
    tryRepairAppointmentLifecycle: repairAppointmentLifecycle,
  };
  const command = createAppointmentreschedule1Methods(deps);
  const input = { startAt: new Date(+startAt + 86400000), endAt: new Date(+endAt + 86400000) };
  const run = () => command.reschedule({ business, appointmentId: original._id, input, idempotencyKey: 'same-reschedule' });
  return { business, original, conversation, lead, provider, providerEvents, deps, run, input };
}

async function expectConverged(f) {
  const original = await Appointment.findById(f.original._id);
  const replacement = await Appointment.findOne({ business: f.business._id, idempotencyKey: 'same-reschedule' });
  expect(original).toMatchObject({ status: 'rescheduled', rescheduledTo: replacement._id, externalAppointmentId: null });
  expect(replacement).toMatchObject({ status: 'confirmed', rescheduledFrom: original._id, externalAppointmentId: 'event-1' });
  expect(f.providerEvents.size).toBe(1);
  expect(await Appointment.countDocuments({ business: f.business._id, status: 'confirmed' })).toBe(1);
  expect(await Conversation.findById(f.conversation._id)).toMatchObject({ bookingState: { status: 'booked', appointment: replacement._id } });
  expect(await Lead.findById(f.lead._id)).toMatchObject({ appointment: replacement._id });
  const jobs = await AppointmentNotificationJob.find({ appointment: replacement._id });
  expect(jobs.filter(job => job.type === 'reminder')).toHaveLength(1);
  expect(jobs.filter(job => job.type === 'change_notice')).toHaveLength(1);
  return replacement;
}

test.each(['hold-created', 'provider-applied', 'handoff-staged', 'finalized'])('same-key replay after %s converges at the baseline', async boundary => {
  const f = await fixture();
  const interruption = Error(`interrupted: ${boundary}`);
  let interrupted = false;
  if (boundary === 'hold-created') {
    const createHold = f.deps.createHold;
    // Factories capture dependencies at construction; wrap the model boundary instead.
    void createHold;
    const create = Appointment.create.bind(Appointment);
    jest.spyOn(Appointment, 'create').mockImplementation(async data => {
      const row = await create(data);
      if (data.idempotencyKey === 'same-reschedule' && !interrupted) { interrupted = true; throw interruption; }
      return row;
    });
  } else if (boundary === 'provider-applied') {
    const update = f.provider.updateAppointment.getMockImplementation();
    f.provider.updateAppointment.mockImplementationOnce(async args => { await update(args); interrupted = true; throw interruption; });
  } else {
    const save = Appointment.prototype.save;
    jest.spyOn(Appointment.prototype, 'save').mockImplementation(async function (...args) {
      const result = await save.apply(this, args);
      const hit = boundary === 'handoff-staged'
        ? this.pendingRescheduleExternalAppointmentId === 'event-1'
        : String(this._id) === String(f.original._id) && this.status === 'rescheduled';
      if (hit && !interrupted) { interrupted = true; throw interruption; }
      return result;
    });
  }
  await expect(f.run()).rejects.toThrow(interruption.message);
  expect(interrupted).toBe(true);
  jest.restoreAllMocks();
  await f.run();
  const replacement = await expectConverged(f);
  await AppointmentNotificationJob.updateMany({ appointment: replacement._id }, { $set: { status: 'sent', sentAt: new Date(), providerMessageId: 'synthetic-receipt' } });
  await f.run();
  expect(await AppointmentNotificationJob.countDocuments({ appointment: replacement._id, status: 'sent', providerMessageId: 'synthetic-receipt' })).toBe(2);
  await expectConverged(f);
});

test('baseline characterization: finalization overwrites a newer cancellation of the original', async () => {
  const f = await fixture();
  const update = f.provider.updateAppointment.getMockImplementation();
  f.provider.updateAppointment.mockImplementationOnce(async args => {
    await Appointment.updateOne({ _id: f.original._id }, { $set: { status: 'canceled' } });
    return update(args);
  });
  await f.run();
  // A version/claim predicate would reject this completion, changing baseline behavior.
  expect((await Appointment.findById(f.original._id)).status).toBe('rescheduled');
});

test('baseline characterization: reminder scheduling resets an existing delivery receipt', async () => {
  const f = await fixture();
  const replacement = await f.run();
  await AppointmentNotificationJob.updateOne({ appointment: replacement._id, type: 'reminder' },
    { $set: { status: 'sent', sentAt: new Date(), providerMessageId: 'synthetic-receipt' } });
  await scheduleAppointmentReminders({ appointment: replacement });
  expect(await AppointmentNotificationJob.findOne({ appointment: replacement._id, type: 'reminder' })).toMatchObject({
    status: 'scheduled', providerMessageId: '', sentAt: null,
  });
});
