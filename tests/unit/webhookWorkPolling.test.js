import { startWebhookWorkWorker, stopWebhookWorkWorker } from '../../src/workers/webhookWork.worker.js';
import { claimWebhookWork, enqueueWebhookWork } from '../../src/services/webhooks/webhookWork.service.js';
import { wakeLocalQueue } from '../../src/services/localQueueWake.service.js';
import WebhookWork from '../../src/models/webhookWork.js';
import { processRecoveryIntroductionJob } from '../../src/services/twilioSmsWebhook.service.js';

jest.mock('../../src/services/webhooks/webhookWork.service.js', () => ({
  ...jest.requireActual('../../src/services/webhooks/webhookWork.service.js'),
  claimWebhookWork: jest.fn(),
}));
jest.mock('../../src/models/webhookWork.js', () => ({ __esModule: true, default: {
  findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
} }));
jest.mock('../../src/services/twilioSmsWebhook.service.js', () => ({ processRecoveryIntroductionJob: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createSystemAlert: jest.fn() } }));

beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  claimWebhookWork.mockResolvedValue(null);
  WebhookWork.updateOne.mockResolvedValue({matchedCount: 1});
});
afterEach(async () => { await stopWebhookWorkWorker(); jest.useRealTimers(); });

test('idle webhook polls back off to 3s, enqueue wakes locally, and stop removes the listener', async () => {
  await startWebhookWorkWorker();
  await jest.advanceTimersByTimeAsync(0);
  expect(claimWebhookWork).toHaveBeenCalledTimes(5);
  await jest.advanceTimersByTimeAsync(499);
  expect(claimWebhookWork).toHaveBeenCalledTimes(5);
  await jest.advanceTimersByTimeAsync(1);
  await jest.advanceTimersByTimeAsync(1000);
  await jest.advanceTimersByTimeAsync(2000);
  expect(claimWebhookWork).toHaveBeenCalledTimes(20);
  await jest.advanceTimersByTimeAsync(2999);
  expect(claimWebhookWork).toHaveBeenCalledTimes(20);
  WebhookWork.findOneAndUpdate.mockResolvedValue({_id: 'job'});
  await enqueueWebhookWork({kind: 'recovery_sms', businessId: 'business', eventId: 'event', payload: {}});
  await jest.advanceTimersByTimeAsync(0);
  expect(claimWebhookWork).toHaveBeenCalledTimes(25);
  await stopWebhookWorkWorker(); wakeLocalQueue('webhook-work');
  await jest.advanceTimersByTimeAsync(10000);
  expect(claimWebhookWork).toHaveBeenCalledTimes(25);
});

test('finding work resets the next webhook poll to its busy interval', async () => {
  await startWebhookWorkWorker(); await jest.advanceTimersByTimeAsync(1500);
  claimWebhookWork.mockResolvedValueOnce({_id: 'job', kind: 'recovery_sms', business: 'business', leaseToken: 'lease', attempts: 1});
  processRecoveryIntroductionJob.mockResolvedValue(undefined);
  wakeLocalQueue('webhook-work'); await jest.advanceTimersByTimeAsync(0);
  expect(processRecoveryIntroductionJob).toHaveBeenCalledTimes(1);
  const count = claimWebhookWork.mock.calls.length;
  await jest.advanceTimersByTimeAsync(249);
  expect(claimWebhookWork).toHaveBeenCalledTimes(count);
  await jest.advanceTimersByTimeAsync(1);
  expect(claimWebhookWork).toHaveBeenCalledTimes(count + 5);
});
