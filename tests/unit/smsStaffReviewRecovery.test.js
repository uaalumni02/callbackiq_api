import SmsProcessingJob from '../../src/models/smsProcessingJob.js';
import WebhookWork from '../../src/models/webhookWork.js';
import AlertService from '../../src/services/alert.service.js';
import { recoverFailedSmsStaffReviews, recoverFailedWebhookReviews } from '../../src/services/smsStaffReviewRecovery.service.js';
jest.mock('../../src/models/smsProcessingJob.js', () => ({ __esModule: true, default: { find: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn().mockResolvedValue(null) } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn() } }));
beforeEach(() => {
 jest.clearAllMocks();
 const query = { sort: () => query, limit: () => query, lean: async () => [{ _id: 'j1', business: 'b1', lead: 'l1', conversation: 'c1', inboundMessage: 'm1' }] };
 SmsProcessingJob.find.mockReturnValue(query);
});
test('stores a linked action-required failure before marking recovery complete', async () => {
 AlertService.create.mockResolvedValue({ alert: { _id: 'a1' } });
 expect(await recoverFailedSmsStaffReviews()).toEqual({ recovered: 1 });
 expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'b1', conversationId: 'c1', leadId: 'l1', type: 'integration_failure', actionRequired: true, dedupeKey: 'sms_staff_review_dead:j1' }));
 expect(AlertService.create.mock.invocationCallOrder[0]).toBeLessThan(SmsProcessingJob.updateOne.mock.invocationCallOrder[0]);
});
test('failed alert creation leaves the durable job eligible for another pass', async () => {
 AlertService.create.mockRejectedValue(new Error('database unavailable'));
 await expect(recoverFailedSmsStaffReviews()).rejects.toThrow('database unavailable');
 expect(SmsProcessingJob.updateOne).not.toHaveBeenCalled();
});

jest.mock('../../src/models/webhookWork.js', () => ({ __esModule: true, default: { find: jest.fn(), updateOne: jest.fn() } }));
test('dead webhook work is marked reviewed only after an idempotent alert persists', async () => {
 const query = { sort: () => query, limit: () => query, lean: async () => [{ _id: 'w1', business: 'b1', kind: 'recovery' }] };
 WebhookWork.find.mockReturnValue(query);
 AlertService.create.mockResolvedValue({ alert: { _id: 'a1' } });
 expect(await recoverFailedWebhookReviews()).toEqual({ recovered: 1 });
 expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'b1', actionRequired: true, dedupeKey: 'recovery_staff_review:w1' }));
 expect(AlertService.create.mock.invocationCallOrder[0]).toBeLessThan(WebhookWork.updateOne.mock.invocationCallOrder[0]);
});
test('unpersisted webhook alerts remain eligible for recovery', async () => {
 const query = { sort: () => query, limit: () => query, lean: async () => [{ _id: 'w1', business: 'b1' }] };
 WebhookWork.find.mockReturnValue(query);
 AlertService.create.mockResolvedValue({});
 await expect(recoverFailedWebhookReviews()).rejects.toThrow('not persisted');
 expect(WebhookWork.updateOne).not.toHaveBeenCalled();
});
