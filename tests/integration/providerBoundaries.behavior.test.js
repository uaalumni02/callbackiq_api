import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import VoiceSession from '../../src/models/voiceSession.js';
import VoiceSessionService from '../../src/voice/voiceSession.service.js';
import A2pCustomerRegistration from '../../src/models/a2pCustomerRegistration.js';
import { acquireDistributedLease, releaseDistributedLease } from '../../src/services/distributedLease.service.js';
import { runA2pReconciliationCycle } from '../../src/workers/a2pReconciliation.worker.js';
import { syncA2pCustomerRegistration } from '../../src/services/a2pCustomerOnboarding.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

jest.mock('../../src/services/a2pCustomerOnboarding.service.js', () => ({ syncA2pCustomerRegistration: jest.fn() }));
beforeAll(connectTestDB,60000);
afterEach(async () => { jest.clearAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);
const business = () => Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Boundary Plumbing', businessType: 'plumbing', phone: '+14045550121', forwardingPhone: '+14045550122' });
test('completion merges new metadata while retaining callback state and existing facts', async () => {
  const owner = await business();
  const session = await VoiceSession.create({ business: owner._id, providerCallSid: 'CA00000000000000000000000000000008', from: '+14045550129', to: owner.phone,
    status: 'active', metadata: { callbackCapture: { status: 'collecting_name' }, existingFact: 'retained' } });
  await VoiceSessionService.markCompleted(session._id,{ completionReason: 'normal' });
  const stored = await VoiceSession.findById(session._id); expect(stored.status).toBe('completed');
  expect(stored.metadata).toMatchObject({ existingFact: 'retained', completionReason: 'normal', callbackCapture: { status: 'collecting_name' } });
});
test('A2P worker respects a real distributed lease held by another process', async () => {
  const owner = await business(); await A2pCustomerRegistration.create({ business: owner._id, status: 'brand_pending' });
  const key = `a2p-reconcile:${owner._id}`, claim = await acquireDistributedLease(key); expect(claim.acquired).toBe(true);
  await runA2pReconciliationCycle(); expect(syncA2pCustomerRegistration).not.toHaveBeenCalled();
  await releaseDistributedLease(key,claim.ownerToken); syncA2pCustomerRegistration.mockResolvedValue({ status: 'brand_approved' });
  await runA2pReconciliationCycle(); expect(syncA2pCustomerRegistration).toHaveBeenCalledTimes(1);
  expect(String(syncA2pCustomerRegistration.mock.calls[0][0].businessId)).toBe(String(owner._id));
});
test.each(['voice-complete','voice-transfer-complete','voice-overflow'])('%s cannot fabricate CRM records for an unknown completed call', async endpoint => {
  const owner = await business();
  const response = await request(app).post(`/api/twilio/${endpoint}`).type('form').send({ To: owner.phone, From: '+14045550129', CallSid: 'CA00000000000000000000000000000009', CallStatus: 'completed' });
  expect(response.status).toBe(200); expect(await Lead.countDocuments()).toBe(0);
  expect(await Conversation.countDocuments()).toBe(0); expect(await VoiceSession.countDocuments()).toBe(0); expect(await Business.countDocuments()).toBe(1);
});
