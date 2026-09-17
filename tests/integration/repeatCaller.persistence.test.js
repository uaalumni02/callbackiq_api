import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import CallLog from '../../src/models/callLog.js';
import VoiceSession from '../../src/models/voiceSession.js';
import VoiceCallerWindow from '../../src/models/voiceCallerWindow.js';
import ProductionOperationLease from '../../src/models/productionOperationLease.js';
import { getOrCreateSmsLeadAndConversation } from '../../src/services/messaging/smsConversation.service.js';
import { claimRecoveryIntroduction } from '../../src/services/messaging/recoveryIntroduction.service.js';
import { deliverRecoveryIntroduction } from '../../src/services/twilioSmsWebhook.service.js';
import { runVoiceConversationTurn } from '../../src/services/voiceConversationTurn.service.js';
import { evaluateCallerVelocity } from '../../src/services/voiceFraudDetection.service.js';
import VoiceSessionService from '../../src/voice/voiceSession.service.js';
import { sendSms } from '../../src/services/twilioSmsService.js';

jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: new Proxy({}, { get: () => jest.fn() }) }));
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createSystemAlert: jest.fn(), createMissedCallAlert: jest.fn() } }));
jest.mock('../../src/services/marketingAttribution.service.js', () => ({ resolveTrackingNumberContext: jest.fn(async () => null), syncLatestAttribution: jest.fn() }));
jest.mock('../../src/voice/voiceTranscript.service.js', () => ({ __esModule: true, default: { finalize: jest.fn() } }));
jest.mock('../../src/voice/voiceLineType.service.js', () => ({ __esModule: true, default: { lookup: jest.fn(async () => ({ landline: false })) } }));
jest.mock('../../src/services/messaging/contactPreference.service.js', () => ({ isSmsSuppressed: jest.fn(async () => false) }));

jest.setTimeout(120000);
let mongo, business;
const phone = '+14045550199';
const call = (sid, caller = phone) => VoiceSessionService.ensureContext({ business, from: caller, to: business.phone, providerCallSid: sid });
const recover = (sid) => getOrCreateSmsLeadAndConversation({ business, customerPhone: phone, source: 'missed_call', recoveryJourneyKey: sid });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Business, Conversation, Lead, CallLog, VoiceSession, VoiceCallerWindow, ProductionOperationLease].map(m => m.init()));
});
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  jest.clearAllMocks();
  sendSms.mockImplementation(async () => ({ sid: `SM${sendSms.mock.calls.length}`, status: 'queued' }));
  business = await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Repeat Caller Plumbing', businessType: 'plumbing', phone: '+14045550100', forwardingPhone: '+14045550101', isActive: true, features: { missedCallSmsEnabled: true } });
});

test.each(['collecting_preference', 'pending_business_confirmation', 'booked'])('repeat missed calls preserve %s beyond the cooldown', async status => {
  const { conversation } = await recover('CA-first');
  const appointment = new mongoose.Types.ObjectId();
  await Conversation.updateOne({ _id: conversation._id }, { $set: {
    'bookingState.status': status, 'bookingState.streetAddress': '123 Main St', 'bookingState.appointment': appointment,
    'orchestration.recoveryIntroClaimedAt': new Date(Date.now() - 20 * 60_000),
    'orchestration.handoffStatus': 'pending_ack',
    'conversationMemory.recoveryIntake': { journeyKey: 'CA-first', started: true, service: 'leaking sink', address: '123 Main St' },
  } });
  await Promise.all(['CA-two', 'CA-three', 'CA-four'].map(recover));
  const saved = await Conversation.findById(conversation._id);
  expect(saved.bookingState.status).toBe(status);
  expect(saved.bookingState.streetAddress).toBe('123 Main St');
  expect(String(saved.bookingState.appointment)).toBe(String(appointment));
  expect(saved.orchestration.recoveryJourneyKey).toBe('CA-first');
  expect(saved.orchestration.handoffStatus).toBe('pending_ack');
  expect(saved.conversationMemory.recoveryIntake.service).toBe('leaking sink');
});

test('old human takeover is preserved and suppresses both recovery paths', async () => {
  const first = await recover('CA-first');
  await Conversation.updateOne({ _id: first.conversation._id }, { $set: { humanTakeover: true, aiEnabled: false, humanTakeoverAt: new Date(0), lastMessageAt: new Date(0) } });
  const { conversation } = await recover('CA-later');
  expect(conversation.humanTakeover).toBe(true);
  expect(conversation.aiEnabled).toBe(false);
  expect(await claimRecoveryIntroduction({ businessId: business._id, conversationId: conversation._id })).toBe(false);
  const session = await call('CA-voice');
  await VoiceSessionService.sendFallbackSms({ sessionId: session._id, alert: false });
  expect(sendSms).not.toHaveBeenCalled();
});

test('three first-time voice calls share identity but keep separate call logs', async () => {
  const sessions = await Promise.all(['CA-one', 'CA-two', 'CA-three'].map(sid => call(sid)));
  expect(await Lead.countDocuments()).toBe(1);
  expect(await Conversation.countDocuments()).toBe(1);
  expect(await CallLog.countDocuments()).toBe(3);
  expect(new Set(sessions.map(s => String(s.conversation._id))).size).toBe(1);
});

test('returning voice caller safely reuses closed conversation', async () => {
  const { conversation } = await recover('CA-original');
  await Conversation.updateOne({ _id: conversation._id }, { $set: { status: 'closed', 'bookingState.streetAddress': '123 Main St' } });
  const session = await call('CA-return');
  expect(String(session.conversation._id)).toBe(String(conversation._id));
  expect(await Conversation.countDocuments()).toBe(1);
  const operation = jest.fn();
  const result = await runVoiceConversationTurn({ session, customerMessage: 'What is the status?', operation });
  expect(result.reply).toMatch(/team review/);
  expect(operation).not.toHaveBeenCalled();
  expect(session.conversation.bookingState.streetAddress).toBe('123 Main St');
});

test('three simultaneous fallback calls send one introduction', async () => {
  const sessions = await Promise.all(['CA-one', 'CA-two', 'CA-three'].map(sid => call(sid)));
  await Promise.all(sessions.map(s => VoiceSessionService.sendFallbackSms({ sessionId: s._id, alert: false })));
  expect(sendSms).toHaveBeenCalledTimes(1);
  expect(sendSms.mock.calls[0][0].metadata.idempotencyKey).toMatch(/^missed-call-recovery:/);
  expect(await VoiceSession.countDocuments({ fallbackSmsStatus: 'suppressed' })).toBe(2);
});

test.each(['sms-first', 'voice-first'])('%s introduction suppresses the other channel', async order => {
  const a = await call('CA-sms');
  const b = await call('CA-voice');
  const sms = () => deliverRecoveryIntroduction({ business, conversation: a.conversation, lead: a.lead, callLog: a.callLog, callSid: a.providerCallSid, customerPhone: phone, starterText: 'Hello', smsEnabled: true, smsStatus: 'queued', strict: true });
  const voice = () => VoiceSessionService.sendFallbackSms({ sessionId: b._id, alert: false });
  if (order === 'sms-first') { await sms(); await voice(); } else { await voice(); await sms(); }
  expect(sendSms).toHaveBeenCalledTimes(1);
});

test('failed fallback retries reuse the exact provider operation key', async () => {
  const session = await call('CA-retry');
  sendSms.mockRejectedValueOnce(Object.assign(new Error('uncertain provider outcome'), { code: 'SMS_DELIVERY_RECONCILIATION_REQUIRED' }));
  await VoiceSessionService.sendFallbackSms({ sessionId: session._id, alert: false });
  await VoiceSessionService.sendFallbackSms({ sessionId: session._id, alert: false });
  expect(sendSms).toHaveBeenCalledTimes(2);
  expect(sendSms.mock.calls[0][0].metadata.idempotencyKey).toBe(sendSms.mock.calls[1][0].metadata.idempotencyKey);
});

test('same caller voice sessions cannot sequentially overwrite each other’s request', async () => {
  const a = await call('CA-owner');
  const b = await call('CA-overlap');
  const write = (session, address) => runVoiceConversationTurn({ session, customerMessage: address, operation: async () => {
    session.conversation.bookingState.streetAddress = address;
    await session.conversation.save();
    return { reply: address };
  } });
  await write(a, '123 Main St');
  expect((await write(b, '999 Other St')).reply).toMatch(/Another call/);
  await write(a, '124 Main St');
  await VoiceSession.updateOne({ _id: a._id }, { $set: { status: 'completed' } });
  expect((await write(b, '999 Other St')).reply).toMatch(/Another call/);
  const c = await call('CA-later');
  expect((await write(c, '125 Main St')).reply).toBe('125 Main St');
  expect((await Conversation.findById(a.conversation._id)).bookingState.streetAddress).toBe('125 Main St');
  expect((await VoiceSession.findById(b._id)).metadata.sharedRequestReadOnly).toBe(true);
});

test('overlapping caller still receives immediate hazard guidance', async () => {
  const a = await call('CA-owner'); const b = await call('CA-overlap');
  await runVoiceConversationTurn({ session: a, customerMessage: 'leaking faucet', operation: async () => ({ reply: 'address?' }) });
  const operation = jest.fn();
  const result = await runVoiceConversationTurn({ session: b, customerMessage: 'I smell gas', operation });
  expect(result.reply).toMatch(/leave|911/i); expect(operation).not.toHaveBeenCalled();
});

test('velocity admits exactly ten concurrent distinct calls and replays each decision', async () => {
  const args = { businessId: business._id, callerPhone: phone, now: new Date(), maxCalls: 10 };
  const decisions = await Promise.all(Array.from({ length: 20 }, (_, i) => evaluateCallerVelocity({ ...args, providerCallSid: `CA-${i}` })));
  expect(decisions.filter(d => d.allowed)).toHaveLength(10);
  const replays = await Promise.all(Array.from({ length: 20 }, (_, i) => evaluateCallerVelocity({ ...args, providerCallSid: `CA-${i}` })));
  expect(replays.map(d => d.allowed)).toEqual(decisions.map(d => d.allowed));
  expect((await VoiceCallerWindow.findOne()).attempts).toHaveLength(20);
});

test('concurrent retries count once; tenants and rolling window remain independent', async () => {
  const now = new Date();
  const args = { businessId: business._id, callerPhone: phone, providerCallSid: 'CA-retry', maxCalls: 1, now };
  const retries = await Promise.all(Array.from({ length: 12 }, () => evaluateCallerVelocity(args)));
  expect(retries.every(d => d.allowed && d.count === 1)).toBe(true);
  expect((await evaluateCallerVelocity({ ...args, providerCallSid: 'CA-second' })).allowed).toBe(false);
  expect((await evaluateCallerVelocity({ ...args, businessId: new mongoose.Types.ObjectId() })).allowed).toBe(true);
  expect((await evaluateCallerVelocity({ ...args, providerCallSid: 'CA-expired', now: new Date(now.getTime() + 60 * 60_000) })).allowed).toBe(true);
});
