import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import Alert from '../../src/models/alert.js';
import WebhookEvent from '../../src/models/webhookEvent.js';
import * as eventService from '../../src/services/webhooks/twilioWebhookEvent.service.js';
import * as messageService from '../../src/services/messaging/smsIngressPersistence.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
jest.mock('twilio', () => {
  const provider = jest.fn(() => ({ messages: { create: jest.fn(() => { throw new Error('No outbound sends expected'); }) } }));
  provider.validateRequest = jest.fn(() => true); return provider;
});
beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC_TEST'; process.env.TWILIO_AUTH_TOKEN = 'AUTH_TEST';
  await connectTestDB(); await Promise.all([Message.init(), WebhookEvent.init(), Alert.init(), Lead.init(), Conversation.init()]);
}, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); }, 30000);
afterAll(async () => { await closeTestDB(); }, 30000);
const seed = async () => {
  const business = await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'HVAC Test', businessType: 'hvac',
    phone: '+14045550124', forwardingPhone: '+14045550125', email: 'test@example.com', isActive: true,
    estimatedJobValue: 800, trackingNumber: { provider: 'twilio', status: 'active' }, features: { automatedFollowUpEnabled: false } });
  const lead = await Lead.create({ business: business._id, customerName: 'Test', phone: '+14045550123', serviceNeeded: 'AC repair', urgency: 'medium', source: 'sms', status: 'contacted' });
  await Conversation.create({ business: business._id, lead: lead._id, customerPhone: '+14045550123', aiEnabled: false, humanTakeover: true });
  return business;
};
const send = business => request(app).post('/api/twilio/sms').type('form').send({ MessageSid: 'SM_ACK_TEST', From: '+14045550123', To: business.phone, Body: 'The service address is 123 Main Street' });

test('HTTP acknowledgement waits for message persistence to settle', async () => {
  const business = await seed();
  const native = messageService.persistInboundSmsMessage;
  let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  jest.spyOn(messageService, 'persistInboundSmsMessage').mockImplementationOnce(async (...args) => {
    entered(); await gate; return native(...args);
  });
  let finished = false;
  const response = Promise.resolve(send(business)).then(result => { finished = true; return result; });
  await ready; await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(false); expect(await Message.countDocuments()).toBe(0);
  release(); expect((await response).status).toBe(200);
  expect(await Message.countDocuments({ direction: 'inbound' })).toBe(1);
  expect(await WebhookEvent.countDocuments({ status: 'completed' })).toBe(1);
});

test('lost settlement lease returns a retryable response; replay completes without duplicating messages or alerts', async () => {
  const business = await seed();
  jest.spyOn(eventService, 'completeTwilioWebhookEvent').mockResolvedValueOnce(null);
  expect((await send(business)).status).toBe(503);
  expect(await WebhookEvent.countDocuments({ status: 'completed' })).toBe(0);
  expect((await send(business)).status).toBe(200);
  expect(await Message.countDocuments({ direction: 'inbound' })).toBe(1);
  expect(await Message.countDocuments({ direction: 'outbound' })).toBe(0);
  expect(await Alert.countDocuments({ type: 'customer_reply' })).toBe(1);
  expect(await WebhookEvent.countDocuments({ status: 'completed' })).toBe(1);
});

test('failure before webhook claim persistence returns 503 and a retry commits exactly once', async () => {
  const business = await seed();
  jest.spyOn(eventService, 'claimTwilioWebhookEvent').mockRejectedValueOnce(new Error('claim database unavailable'));
  expect((await send(business)).status).toBe(503);
  expect(await Message.countDocuments()).toBe(0);
  expect((await send(business)).status).toBe(200);
  expect(await Message.countDocuments({direction:'inbound'})).toBe(1);
  expect(await WebhookEvent.countDocuments({status:'completed'})).toBe(1);
});
