import WebhookWork from '../../src/models/webhookWork.js';
import { enqueueWebhookWork, claimWebhookWork } from '../../src/services/webhooks/webhookWork.service.js';
import { processWebhookWork } from '../../src/workers/webhookWork.worker.js';
import AlertService from '../../src/services/alert.service.js';
afterEach(() => jest.restoreAllMocks());
test('a replay uses the same tenant-scoped durable identity without resetting completed work', async () => {
  const spy = jest.spyOn(WebhookWork, 'findOneAndUpdate').mockResolvedValue({ status: 'completed' });
  const input = { kind: 'recovery_sms', businessId: 'b1', eventId: 'CA1', payload: { callSid: 'CA1' } };
  await enqueueWebhookWork(input); await enqueueWebhookWork(input);
  expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]);
  expect(Object.keys(spy.mock.calls[0][1])).toEqual(['$setOnInsert']);
  await enqueueWebhookWork({ ...input, businessId: 'b2' });
  expect(spy.mock.calls[2][0]).not.toEqual(spy.mock.calls[0][0]);
});
test('concurrent first insert recovers the winner after duplicate-key error', async () => {
  jest.spyOn(WebhookWork, 'findOneAndUpdate').mockRejectedValue({ code: 11000 });
  jest.spyOn(WebhookWork, 'findById').mockResolvedValue({ status: 'queued' });
  await expect(enqueueWebhookWork({ kind: 'recovery_sms', businessId: 'b', eventId: 'CA1', payload: {} })).resolves.toMatchObject({ status: 'queued' });
});
test('claims reclaim crashed processing work with a new fencing token and increment attempts', async () => {
  const spy = jest.spyOn(WebhookWork, 'findOneAndUpdate').mockReturnValue({ lean: async () => null });
  await claimWebhookWork(); await claimWebhookWork();
  const [filter, update] = spy.mock.calls[0];
  expect(filter.$or).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'processing', leaseUntil: expect.any(Object) })]));
  expect(update.$inc.attempts).toBe(1);
  expect(update.$set.leaseToken).not.toBe(spy.mock.calls[1][1].$set.leaseToken);
});
test('failed processing is fenced and retryable; exhausted work becomes visible for review', async () => {
  const writes = jest.spyOn(WebhookWork, 'updateOne').mockResolvedValue({ matchedCount: 1 });
  const alert = jest.spyOn(AlertService, 'createSystemAlert').mockResolvedValue({});
  const job = { _id: 'j', leaseToken: 'owner', kind: 'invalid', attempts: 1, business: 'b' };
  await processWebhookWork(job);
  expect(writes.mock.calls[0][0]).toEqual({ _id: 'j', status: 'processing', leaseToken: 'owner' });
  expect(writes.mock.calls[0][1].$set.status).toBe('queued'); expect(alert).not.toHaveBeenCalled();
  await processWebhookWork({ ...job, attempts: 8 });
  expect(writes.mock.calls[1][1].$set.status).toBe('dead'); expect(alert).toHaveBeenCalled();
});
