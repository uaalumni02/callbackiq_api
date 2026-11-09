import { assertConfirmationNotPending, confirmationPending } from '../../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { confirmWithoutRecovery } from '../../src/services/scheduling/commands/confirmWithoutRecovery.js';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Appointment from '../../src/models/appointment.js';
import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import { scheduleAppointmentReminders } from '../../src/services/scheduling/appointmentNotification.service.js';
import { bookingStateFields } from '../../src/services/booking/requestBookingState.js';
import { createConfirmationIntentRepository } from '../../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { createConfirmationRecovery } from '../../src/services/scheduling/appointmentConfirmationRecovery.service.js';
import { createAppointmentconfirm1Methods } from '../../src/services/scheduling/commands/confirm-1.js';
import { createExpiredHoldReconciler } from '../../src/services/scheduling/appointmentHoldExpiry.service.js';

jest.setTimeout(45_000);
let replica;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri(), { dbName: 'appointmentConfirmationCrash' });
  await Promise.all([Appointment.init(), AppointmentNotificationJob.init()]);
});
afterEach(async () => {
  if (mongoose.connection.readyState === 1) await Promise.all([Appointment.deleteMany({}), AppointmentNotificationJob.deleteMany({})]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

const objectId = () => new mongoose.Types.ObjectId();

async function fixture() {
  let millis = Date.now();
  let stopAt;
  const crash = new Error('simulated process exit');
  const clock = () => new Date(millis);
  const advance = (amount = 120_001) => { millis += amount; };
  const business = { _id: objectId() };
  const staff = objectId();
  const appointment = await Appointment.create({
    business: business._id, customerPhone: '+14045550100', conversation: objectId(),
    serviceOffering: objectId(), startAt: new Date(millis + 172_800_000), endAt: new Date(millis + 176_400_000),
    status: 'held', heldExpiresAt: new Date(millis + 300_000),
    idempotencyKey: 'booking', requiresBusinessApproval: true, activeSlotKey: 'slot', slotClaimKeys: ['slot'],
  });
  const events = new Map();
  const target = { calendarId: 'original-calendar', eventId: 'deterministic-event' };
  const provider = {
    prepareConfirmation: jest.fn(async () => target),
    createAppointment: jest.fn(async ({ target: actual }) => {
      expect(actual.calendarId).toBe(target.calendarId);
      expect(actual.eventId).toBe(target.eventId);
      const result = { provider: 'google_calendar', externalAppointmentId: target.eventId, externalCalendarId: target.calendarId };
      events.set(target.eventId, result);
      return result;
    }),
    findConfirmation: jest.fn(async ({ target: actual }) => events.get(actual.eventId) || null),
    assertConfirmationRetryTarget: jest.fn(),
    cancelAppointment: jest.fn(async () => { events.delete(target.eventId); }),
  };
  const intent = createConfirmationIntentRepository({ Appointment, clock });
  const service = { _id: appointment.serviceOffering };
  const deps = {
    assertConfirmationNotPending, confirmationPending, confirmWithoutRecovery,
    intent, bookingStateFields, clock, Business: { findById: jest.fn(async () => business) },
    getAppointmentForBusiness: (businessId, id) => Appointment.findOne({ _id: id, business: businessId }, '+confirmationIntent'),
    assertTransition: jest.fn(), assertServiceRequestEligible: jest.fn(),
    exactSlotAvailable: jest.fn(async () => true), preservePendingApprovalOnAvailabilityConflict: jest.fn(() => true),
    ServiceOffering: { findById: jest.fn(async () => service), findOne: jest.fn(async () => service) },
    SchedulingProviderFactory: { getProvider: jest.fn(() => provider) },
    businessCalendarProviderName: jest.fn(() => 'google_calendar'),
    Conversation: { updateOne: jest.fn() },
    InterventionService: { create: jest.fn(), integrationFailure: jest.fn() },
    SocketService: { emitToBusiness: jest.fn(), emitDashboardRefresh: jest.fn() },
    lifecycleMarker: jest.fn(), projectionMarker: jest.fn(() => ({ token: 'projection', pending: true })),
    resolveApprovalReview: jest.fn(), ensureBusinessApprovalNotice: jest.fn(),
    runNonBlockingAppointmentSideEffect: jest.fn(({ task }) => task()),
    tryRepairAppointmentLifecycle: jest.fn(), tryRepairAppointmentProjections: jest.fn(),
    scheduleAppointmentReminders: jest.fn(), safeConsole: { error: jest.fn() }, assertDistributedLeaseActive: jest.fn(),
  };
  const build = (testCrash) => {
    const recovery = createConfirmationRecovery({ ...deps, testCrash });
    return createAppointmentconfirm1Methods({ ...deps, recovery });
  };
  const command = build((phase) => { if (phase === stopAt) throw crash; });
  const secondProcess = build();
  const confirm = () => command.confirm({ business, appointmentId: appointment._id, approvedBy: staff });
  const read = () => Appointment.findById(appointment._id).select('+confirmationIntent');
  return {
    appointment, business, staff, crash, deps, events, provider, intent, confirm, read, advance,
    crashAt: (phase) => { stopAt = phase; },
    recover: () => secondProcess.reconcileConfirmations(),
    recoverConcurrently: () => Promise.all([command.reconcileConfirmations(), secondProcess.reconcileConfirmations()]),
  };
}

async function expectOneConfirmed(f) {
  const stored = await f.read();
  expect(stored).toMatchObject({ status: 'confirmed', externalAppointmentId: 'deterministic-event',
    externalCalendarId: 'original-calendar', approvalDecisionBy: f.staff });
  expect(stored.confirmationIntent).toMatchObject({ status: 'confirmed', effectsPending: false });
  expect(stored.toJSON()).not.toHaveProperty('confirmationIntent');
  expect(await Appointment.countDocuments({ business: f.business._id, status: 'confirmed' })).toBe(1);
  expect(f.events.size).toBe(1);
  expect(f.provider.createAppointment).toHaveBeenCalledTimes(1);
}

test('crash before provider call recovers with one event and one appointment', async () => {
  const f = await fixture();
  f.crashAt('before_provider');
  await expect(f.confirm()).rejects.toBe(f.crash);
  expect((await f.read()).confirmationIntent).toMatchObject({ status: 'pending_provider', attempts: 0 });
  expect(f.events.size).toBe(0);
  await f.recover();
  expect(f.events.size).toBe(0);
  f.advance();
  await f.recover();
  await expectOneConfirmed(f);
});

test('crash after provider success looks up the exact event, then confirms once', async () => {
  const f = await fixture();
  f.crashAt('after_provider');
  await expect(f.confirm()).rejects.toBe(f.crash);
  expect(f.events.size).toBe(1);
  expect((await f.read()).status).toBe('held');
  expect(f.deps.ensureBusinessApprovalNotice).not.toHaveBeenCalled();
  expect(f.deps.scheduleAppointmentReminders).not.toHaveBeenCalled();
  f.advance();
  await f.recover();
  expect(f.provider.findConfirmation).toHaveBeenCalledTimes(1);
  await expectOneConfirmed(f);
});

test('crash after Mongo confirmation recovers reminders without another provider call', async () => {
  const f = await fixture();
  f.crashAt('after_commit');
  await expect(f.confirm()).rejects.toBe(f.crash);
  expect((await f.read()).confirmationIntent).toMatchObject({ status: 'confirmed', effectsPending: true });
  expect(f.deps.scheduleAppointmentReminders).not.toHaveBeenCalled();
  f.advance();
  await f.recover();
  await f.recover();
  expect(f.deps.scheduleAppointmentReminders).toHaveBeenCalledTimes(1);
  expect(f.deps.scheduleAppointmentReminders).toHaveBeenCalledWith(expect.objectContaining({ repairMissingOnly: true }));
  await expectOneConfirmed(f);
});

test('duplicate confirmation while pending cannot call provider twice', async () => {
  const f = await fixture();
  f.crashAt('after_provider');
  await expect(f.confirm()).rejects.toBe(f.crash);
  await expect(f.confirm()).rejects.toMatchObject({ code: 'APPOINTMENT_CONFIRMATION_PENDING' });
  f.advance();
  await f.recover();
  await expectOneConfirmed(f);
});

test('failed compensation leaves the original receipt until the cleanup succeeds', async () => {
  const f = await fixture();
  const patch = f.intent.patch;
  const failure = new Error('Mongo rejected confirmation');
  jest.spyOn(f.intent, 'patch').mockImplementation((row, values) => {
    if (values.status === 'confirmed') throw failure;
    return patch(row, values);
  });
  f.provider.cancelAppointment.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(f.confirm()).rejects.toBe(failure);
  expect((await f.read()).confirmationIntent).toMatchObject({
    status: 'pending_provider', compensation: { eventId: 'deterministic-event', calendarId: 'original-calendar' },
  });
  expect(f.events.size).toBe(1);
  expect(f.deps.InterventionService.create).toHaveBeenCalledTimes(1);
  f.advance();
  await f.recover();
  expect(f.events.size).toBe(0);
  expect((await f.read()).confirmationIntent.status).toBe('failed');
  expect(f.provider.cancelAppointment).toHaveBeenCalledTimes(2);
  expect(f.deps.scheduleAppointmentReminders).not.toHaveBeenCalled();
});

test('two reconcilers cannot claim the same intent, emit twice or double schedule reminders', async () => {
  const f = await fixture();
  f.crashAt('after_provider');
  await expect(f.confirm()).rejects.toBe(f.crash);
  f.crashAt(null);
  f.advance();
  await f.recoverConcurrently();
  expect(f.provider.findConfirmation).toHaveBeenCalledTimes(1);
  expect(f.deps.scheduleAppointmentReminders).toHaveBeenCalledTimes(1);
  expect(f.deps.SocketService.emitToBusiness).toHaveBeenCalledTimes(1);
  await expectOneConfirmed(f);
});

test('pending intent prevents hold expiry and blocks a stale appointment save', async () => {
  const f = await fixture();
  const stale = await f.read();
  f.crashAt('before_provider');
  await expect(f.confirm()).rejects.toBe(f.crash);
  stale.status = 'canceled';
  await expect(stale.save()).rejects.toMatchObject({ name: 'DocumentNotFoundError' });
  await Appointment.updateOne({ _id: stale._id }, { $set: { heldExpiresAt: new Date(0) } });
  const noop = async () => {};
  const release = createExpiredHoldReconciler({ Appointment,
    reconcileApprovalRequests: noop, repairPendingAppointmentLifecycles: noop, repairPendingAppointmentProjections: noop,
    repairRescheduleReviews: noop, reconcileAppointmentNoticeFailures: noop, runApprovalSms: noop,
  });
  expect((await release()).matchedCount).toBe(0);
  expect((await f.read()).activeSlotKey).toBe('slot');
});

test('a late provider response cannot cancel or finalize after a reconciler has taken over', async () => {
  const f = await fixture();
  const create = f.provider.createAppointment.getMockImplementation();
  let release;
  let entered;
  const providerStarted = new Promise((resolve) => { entered = resolve; });
  f.provider.createAppointment.mockImplementationOnce(async (input) => {
    const event = await create(input);
    entered();
    return new Promise((resolve) => { release = () => resolve(event); });
  });
  const result = f.confirm();
  const rejection = expect(result).rejects.toMatchObject({ code: 'APPOINTMENT_CONFIRMATION_PENDING' });
  await providerStarted;
  f.advance();
  await f.recover();
  release();
  await rejection;
  expect(f.provider.cancelAppointment).not.toHaveBeenCalled();
  await expectOneConfirmed(f);
});

test('an uncertain provider timeout keeps its event recoverable and never sends an early notice', async () => {
  const f = await fixture();
  const create = f.provider.createAppointment.getMockImplementation();
  const timeout = new Error('Provider response lost after insertion');
  f.provider.createAppointment.mockImplementationOnce(async (input) => {
    await create(input);
    throw timeout;
  });
  await expect(f.confirm()).rejects.toBe(timeout);
  expect((await f.read()).confirmationIntent.status).toBe('pending_provider');
  expect(f.deps.ensureBusinessApprovalNotice).not.toHaveBeenCalled();
  f.advance();
  await f.recover();
  await expectOneConfirmed(f);
});

test('reminder repair preserves an already sent provider receipt', async () => {
  const f = await fixture();
  await f.confirm();
  const input = { appointment: await f.read(), repairMissingOnly: true,
    settingsOverride: { customerRemindersEnabled: true, reminderHours: [2] } };
  const [job] = await scheduleAppointmentReminders(input);
  await AppointmentNotificationJob.updateOne({ _id: job._id }, {
    $set: { status: 'sent', sentAt: new Date(), providerMessageId: 'SM-receipt' },
  });

  const [replayed] = await scheduleAppointmentReminders(input);
  expect(replayed).toMatchObject({ status: 'sent', providerMessageId: 'SM-receipt' });
  expect(await AppointmentNotificationJob.countDocuments({ appointment: f.appointment._id })).toBe(1);
});

test('a lost commit acknowledgement never compensates an already confirmed event', async () => {
  const f = await fixture();
  const patch = f.intent.patch;
  jest.spyOn(f.intent, 'patch').mockImplementation(async (row, values) => {
    const persisted = await patch(row, values);
    if (values.status === 'confirmed') throw new Error('Commit acknowledgement lost');
    return persisted;
  });

  await expect(f.confirm()).resolves.toMatchObject({ status: 'confirmed' });
  expect(f.provider.cancelAppointment).not.toHaveBeenCalled();
  await expectOneConfirmed(f);
});

test('a lost slot before any provider attempt stays failed even if the staff alert must be retried', async () => {
  const f = await fixture();
  f.crashAt('before_provider');
  await expect(f.confirm()).rejects.toBe(f.crash);
  f.deps.exactSlotAvailable.mockResolvedValue(false);
  f.deps.InterventionService.integrationFailure.mockRejectedValueOnce(Error('Alert unavailable'));

  f.advance();
  await f.recover();
  expect((await f.read())).toMatchObject({ status: 'failed', activeSlotKey: null,
    confirmationIntent: { status: 'failed', effectsPending: true } });
  expect(f.provider.createAppointment).not.toHaveBeenCalled();

  f.advance();
  await f.recover();
  expect((await f.read()).confirmationIntent.effectsPending).toBe(false);
  expect(f.deps.InterventionService.integrationFailure).toHaveBeenCalledTimes(2);
});

test('a calendar target cannot be used if the intent lease changes while it is prepared', async () => {
  const f = await fixture();
  const patch = f.intent.patch;
  jest.spyOn(f.intent, 'patch').mockImplementation((row, values) => {
    if (values['confirmationIntent.target']) return Promise.resolve(null);
    return patch(row, values);
  });
  await expect(f.confirm()).rejects.toMatchObject({ code: 'APPOINTMENT_CONFIRMATION_PENDING' });
  expect(f.provider.createAppointment).not.toHaveBeenCalled();
  expect((await f.read()).confirmationIntent).toMatchObject({ status: 'pending_provider', attempts: 0 });
});

test('a missing event lookup cannot release capacity when an earlier create might still arrive', async () => {
  const f = await fixture();
  f.provider.createAppointment.mockRejectedValueOnce(Error('Unknown provider outcome'));
  await expect(f.confirm()).rejects.toThrow('Unknown provider outcome');
  f.deps.exactSlotAvailable.mockResolvedValue(false);

  f.advance();
  await f.recover();
  expect(await f.read()).toMatchObject({ status: 'held', activeSlotKey: 'slot',
    confirmationIntent: { status: 'pending_provider' } });
  expect(f.provider.createAppointment).toHaveBeenCalledTimes(1);

  f.events.set('deterministic-event', { provider: 'google_calendar', externalAppointmentId: 'deterministic-event',
    externalCalendarId: 'original-calendar' });
  f.advance();
  await f.recover();
  await expectOneConfirmed(f);
});
