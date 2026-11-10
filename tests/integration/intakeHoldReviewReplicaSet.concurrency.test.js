import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import app from '../../src/app.js';
import Token from '../../src/helpers/jwt/token.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import Alert from '../../src/models/alert.js';
import Appointment from '../../src/models/appointment.js';
import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import ServiceArea from '../../src/models/serviceArea.js';
import SchedulingPolicy from '../../src/models/schedulingPolicy.js';
import AvailabilityRule from '../../src/models/availabilityRule.js';
import InternalSchedulingProvider from '../../src/integrations/scheduling/internalScheduling.provider.js';
import AppointmentService from '../../src/services/scheduling/appointment.service.js';
import AvailabilityService from '../../src/services/scheduling/availability.service.js';
import { applyAppointmentBookingTransition } from '../../src/services/booking/appointmentBookingTransition.repository.js';
import { intakeApprovalKey, intakeReviewVersion } from '../../src/services/booking/intakeReviewContext.service.js';

jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));

const originalAddress = '100 Main Street Atlanta GA 30324';
const correctedAddress = '200 Main Street Atlanta GA 30324';
let mongo, business, token, lead, conversation, service, slot;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Alert.init(), Appointment.init()]);
  const owner = await User.create({ userName: 'Review Owner', email: 'owner@example.test', password: 'unused-test-hash',
    businessName: 'Review HVAC', role: 'owner', emailVerified: true, termsAccepted: true, privacyAccepted: true });
  business = await Business.create({ owner: owner._id, businessName: 'Review HVAC', businessType: 'hvac',
    phone: '+14045550199', forwardingPhone: '+14045550198', timezone: 'America/New_York', isActive: true,
    features: { aiBookingEnabled: false } });
  await Subscription.create({ business: business._id, status: 'active', isActive: true, plan: 'pro',
    currentPeriodEnd: new Date(Date.now() + 30 * 86400000) });
  token = Token.sign({ userId: String(owner._id), role: 'owner', sessionVersion: 0 });
  service = await ServiceOffering.create({ business: business._id, name: 'HVAC repair', category: 'hvac',
    active: true, aiCanDiscuss: true, aiCanBook: true, durationMinutes: 60, keywords: ['HVAC repair'] });
  await ServiceArea.create({ business: business._id, zipCodes: ['30324'] });
  await SchedulingPolicy.create({ business: business._id, minimumNoticeMinutes: 60, allowSameDayBooking: true });
  await AvailabilityRule.insertMany(Array.from({ length: 7 }, (_, dayOfWeek) => ({
    business: business._id, dayOfWeek, enabled: true, capacity: 1, windows: [{ startTime: '08:00', endTime: '18:00' }],
  })));
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const { slots } = await AvailabilityService.getAvailability({ business, serviceOfferingId: service._id,
    startDate: day, endDate: day, postalCode: '30324' });
  slot = slots[0];
}, 30000);

beforeEach(async () => {
  await Promise.all([Lead.deleteMany({}), Conversation.deleteMany({}), Appointment.deleteMany({}),
    Alert.deleteMany({}), AppointmentNotificationJob.deleteMany({})]);
  lead = await Lead.create({ business: business._id, customerName: 'Review Customer', phone: '+14045550100',
    serviceNeeded: 'HVAC repair - air conditioner not cooling', urgency: 'high',
    address: originalAddress, preferredAppointmentTime: 'Thursday morning' });
  conversation = await Conversation.create({ business: business._id, lead: lead._id, customerPhone: lead.phone,
    status: 'open', aiEnabled: true, orchestration: { recoveryJourneyKey: 'review' },
    conversationMemory: { recoveryIntake: { submitted: true, journeyKey: 'review' } } });
  await Alert.create({ business: business._id, lead: lead._id, conversation: conversation._id, type: 'human_requested',
    title: 'Review intake', message: 'Ready to review', priority: 'high', actionRequired: true,
    metadata: { handoffReason: 'intake_complete' } });
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

const post = (path, body) => request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
const approve = (version) => post(`/api/conversations/${conversation._id}/approve-intake`, {
  serviceOfferingId: String(service._id), startAt: new Date(slot.startAt).toISOString(),
  endAt: new Date(slot.endAt).toISOString(), intakeReviewVersion: version,
});
const confirm = (id) => post(`/api/appointments/${id}/confirm`, {});
const correctAddress = () => Lead.updateOne({ _id: lead._id }, { $set: { address: correctedAddress } });

async function expectReleased(id) {
  const hold = await Appointment.findById(id).select('+confirmationIntent');
  expect(hold).toMatchObject({ status: 'failed', activeSlotKey: null, capacityLane: null, slotClaimKeys: [] });
  expect(hold.confirmationIntent?.status).not.toBe('pending_provider');
  expect(await AppointmentNotificationJob.countDocuments({ appointment: id })).toBe(0);
  expect(await Conversation.findById(conversation._id)).toMatchObject({
    bookingState: { appointment: null, status: 'not_started' },
    conversationMemory: { recoveryIntake: { reviewAppointmentId: null } },
  });
}

test('a correction during intake approval releases the old hold and allows fresh approval of the same slot', async () => {
  const create = AppointmentService.create.bind(AppointmentService);
  jest.spyOn(AppointmentService, 'create').mockImplementationOnce(async (args) => {
    const hold = await create(args);
    await correctAddress();
    return hold;
  });

  expect((await approve(intakeReviewVersion(conversation, lead))).status).toBe(409);
  const stale = await Appointment.findOne({ conversation: conversation._id });
  await expectReleased(stale._id);
  expect((await confirm(stale._id)).status).toBe(409);
  const ownerRead = await request(app).get(`/api/owner/opportunities/${lead._id}`).set('Authorization', `Bearer ${token}`);
  expect(ownerRead.body.data).toMatchObject({ appointment: null, booking: { intakeReviewAppointmentId: null } });

  const fresh = await approve(ownerRead.body.data.booking.intakeReviewVersion);
  expect(fresh.status).toBe(200);
  expect(fresh.body.data).toMatchObject({ status: 'confirmed', provider: 'internal', address: { street: correctedAddress } });
  expect(await Appointment.countDocuments({ conversation: conversation._id, status: 'confirmed' })).toBe(1);
});

async function createReviewHold({ legacy = false } = {}) {
  const hold = await AppointmentService.create({ business, confirm: false, idempotencyKey: intakeApprovalKey(conversation),
    ...(legacy ? {} : { intakeReviewVersion: intakeReviewVersion(conversation, lead) }),
    input: { lead: lead._id, conversation: conversation._id, serviceOfferingId: service._id,
      customerName: lead.customerName, customerPhone: lead.phone, address: { street: originalAddress, postalCode: '30324' },
      startAt: slot.startAt, endAt: slot.endAt, requiresBusinessApproval: true } });
  await applyAppointmentBookingTransition(Conversation, 'intake_reservation_linked', hold);
  return hold;
}

test.each(['stale', 'legacy', 'expired', 'current'])('the normal appointment action handles a %s intake hold', async (kind) => {
  const hold = await createReviewHold({ legacy: kind === 'legacy' });
  if (kind !== 'current') await correctAddress();
  if (kind === 'expired') await Appointment.updateOne({ _id: hold._id }, {
    $set: { status: 'failed', failureReason: 'Appointment hold expired before confirmation.' },
  });

  const result = await confirm(hold._id);
  if (kind === 'current') {
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ status: 'confirmed', address: { street: originalAddress } });
  } else {
    expect(result.status).toBe(409);
    await expectReleased(hold._id);
  }
});

test('a correction after the confirmation intent is saved prevents the first provider attempt', async () => {
  const update = Appointment.findOneAndUpdate.bind(Appointment);
  jest.spyOn(Appointment, 'findOneAndUpdate').mockImplementation((filter, changes, options) => {
    const query = update(filter, changes, options);
    if (changes.$set?.confirmationIntent?.status === 'pending_provider') {
      query.post(async () => { await correctAddress(); });
    }
    return query;
  });
  expect((await approve(intakeReviewVersion(conversation, lead))).status).toBe(409);
  const stale = await Appointment.findOne({ conversation: conversation._id });
  await expectReleased(stale._id);
  expect(stale.externalAppointmentId).toBeNull();
});

test('a fresh review can retire a hold created before review versions were stored', async () => {
  const legacy = await createReviewHold({ legacy: true });
  const version = intakeReviewVersion(conversation, lead);
  expect((await approve(version)).status).toBe(409);
  await expectReleased(legacy._id);
  expect((await approve(version)).status).toBe(200);
});

test('recovery preserves an uncertain prior provider attempt and never retries stale details', async () => {
  const hold = await createReviewHold();
  const past = new Date(Date.now() - 1000);
  await Appointment.updateOne({ _id: hold._id }, { $set: { confirmationIntent: {
    status: 'pending_provider', key: String(hold._id), provider: 'internal',
    attempts: 1, token: 'previous-owner', leaseUntil: past, nextAttemptAt: past,
  } } });
  await correctAddress();
  const sendToCalendar = jest.spyOn(InternalSchedulingProvider.prototype, 'createAppointment');
  await AppointmentService.reconcileConfirmations();
  expect(sendToCalendar).not.toHaveBeenCalled();
  const pending = await Appointment.findById(hold._id).select('+confirmationIntent');
  expect(pending).toMatchObject({ status: 'held', activeSlotKey: hold.activeSlotKey,
    confirmationIntent: { status: 'pending_provider', attempts: 1 } });
  expect(pending.confirmationIntent.nextAttemptAt.getTime()).toBeGreaterThan(past.getTime());
  expect(await AppointmentNotificationJob.countDocuments({ appointment: hold._id })).toBe(0);
});
