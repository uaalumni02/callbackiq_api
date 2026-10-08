import mongoose from 'mongoose';
import WebhookEvent from '../../src/models/webhookEvent.js';
import { claimTwilioWebhookEvent, completeTwilioWebhookEvent } from '../../src/services/webhooks/twilioWebhookEvent.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
beforeAll(async () => { await connectTestDB(); await WebhookEvent.init(); }, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); }, 30000);
afterAll(async () => { await closeTestDB(); }, 30000);
const claim = (key, business = new mongoose.Types.ObjectId()) => claimTwilioWebhookEvent({ businessId: business, eventType: 'inbound_sms', eventKey: key, providerEventId: key });

test('batch completion uses each lease and persists the cached response', async () => {
  const claims = await Promise.all(Array.from({ length: 64 }, (_, i) => claim(`SM_${i}`)));
  const bulk = jest.spyOn(WebhookEvent, 'bulkWrite');
  const results = await Promise.all(claims.map(row => completeTwilioWebhookEvent(row.event._id, { leaseToken: row.leaseToken, responseBody: '<Response/>', statusCode: 200 })));
  expect(bulk.mock.calls.length).toBe(1);
  expect(results.every(row => row.status === 'completed' && row.responseBody === '<Response/>' && row.leaseToken === '')).toBe(true);
  expect(new Set(results.map(row => row.settlementReceipt)).size).toBe(64);
  expect(await WebhookEvent.countDocuments({ status: 'processing' })).toBe(0);
});

test('a stale lease in a mixed batch never receives another owners completion receipt', async () => {
  const stale = await claim('SM_STALE'); const good = await claim('SM_GOOD');
  const [lost, done] = await Promise.all([
    completeTwilioWebhookEvent(stale.event._id, { leaseToken: 'expired-token' }),
    completeTwilioWebhookEvent(good.event._id, { leaseToken: good.leaseToken }),
  ]);
  expect(lost).toBeNull(); expect(done.status).toBe('completed');
  expect((await WebhookEvent.findById(stale.event._id)).status).toBe('processing');
  expect((await completeTwilioWebhookEvent(stale.event._id, { leaseToken: stale.leaseToken })).status).toBe('completed');
  expect(await completeTwilioWebhookEvent(stale.event._id, { leaseToken: stale.leaseToken })).toBeNull();
});

test('completion failure rejects callers without claiming success and retained leases can retry', async () => {
  const claims = await Promise.all([claim('SM_1'), claim('SM_2')]);
  jest.spyOn(WebhookEvent, 'bulkWrite').mockRejectedValueOnce(new Error('write unavailable'));
  const failures = await Promise.allSettled(claims.map(row => completeTwilioWebhookEvent(row.event._id, { leaseToken: row.leaseToken })));
  expect(failures.every(row => row.status === 'rejected')).toBe(true);
  const retry = await Promise.all(claims.map(row => completeTwilioWebhookEvent(row.event._id, { leaseToken: row.leaseToken })));
  expect(retry.every(row => row.status === 'completed')).toBe(true);
});
