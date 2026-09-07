import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
import WebhookWork from '../../src/models/webhookWork.js';
import { enqueueWebhookWork, claimWebhookWork } from '../../src/services/webhooks/webhookWork.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
beforeAll(async () => { await connectTestDB(); await WebhookWork.init(); });
afterEach(clearTestDB); afterAll(closeTestDB);
test('concurrent webhooks create one durable job, one worker wins, expired lease fences its predecessor', async () => {
  const input = { businessId: new mongoose.Types.ObjectId(), kind: 'recovery_sms', eventId: 'CA_REPLAY', payload: { callSid: 'CA_REPLAY' } };
  const inserts = await Promise.all(Array.from({ length: 20 }, () => enqueueWebhookWork(input)));
  expect(new Set(inserts.map(x => x._id)).size).toBe(1);
  const claims = (await Promise.all(Array.from({ length: 10 }, claimWebhookWork))).filter(Boolean);
  expect(claims).toHaveLength(1);
  const first = claims[0];
  await WebhookWork.updateOne({ _id: first._id }, { $set: { leaseUntil: new Date(0) } });
  const successor = await claimWebhookWork();
  expect(successor.attempts).toBe(2); expect(successor.leaseToken).not.toBe(first.leaseToken);
  const stale = await WebhookWork.updateOne({ _id: first._id, leaseToken: first.leaseToken }, { $set: { status: 'completed' } });
  expect(stale.matchedCount).toBe(0);
  await WebhookWork.updateOne({ _id: successor._id, leaseToken: successor.leaseToken }, { $set: { status: 'completed' } });
  expect((await enqueueWebhookWork(input)).status).toBe('completed');
  expect(await claimWebhookWork()).toBeNull();
});

test('voice recovery acknowledges a durable job without waiting for provider delivery', async () => {
  const previous = process.env.RECOVERY_SMS_ASYNC_ENABLED;
  process.env.RECOVERY_SMS_ASYNC_ENABLED = 'true';
  sendSms.mockImplementation(() => new Promise(() => {}));
  try {
    const business = await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Staging plumbing', businessType: 'plumbing', phone: '+14045551234', email: 'staging@example.test', trackingNumber: { provider: 'twilio', status: 'active' }, features: { missedCallSmsEnabled: true, voiceAiEnabled: false }, voiceSettings: { answerMode: 'disabled', routingPolicy: { openHours: 'sms', afterHours: 'sms', voiceFailure: 'sms' } } });
    const response = await request(app).post('/api/twilio/voice').type('form').send({ From: '+14045559999', To: business.phone, CallSid: 'CA_DURABLE_RECOVERY' });
    expect(response.status).toBe(200); expect(response.text).toMatch(/recorded/);
    expect(sendSms).not.toHaveBeenCalled();
    expect(await WebhookWork.countDocuments({ business: business._id, kind: 'recovery_sms', status: 'queued' })).toBe(1);
  } finally { process.env.RECOVERY_SMS_ASYNC_ENABLED = previous; sendSms.mockReset(); }
});
