import { requestStaffSchedulingReview } from '../../src/services/booking/staffSchedulingReview.service.js';
import { requiresHumanHandoff } from '../../src/services/messaging/smsHandoff.service.js';
import AlertService from '../../src/services/alert.service.js';
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn() } }));
const context = () => ({ business: { _id: 'b', businessName: 'Service Company' }, lead: { _id: 'l', serviceNeeded: 'HVAC repair', urgency: 'high', save: jest.fn().mockResolvedValue(null) }, conversation: { _id: 'c', customerPhone: '+14045550100' }, customerMessage: 'Today please' });
beforeEach(() => { jest.clearAllMocks(); AlertService.createHumanHandoffAlert.mockResolvedValue({ created: true }); });
test('SMS review uses the durable handoff pipeline, without inventing a confirmed appointment', async () => {
 const result = await requestStaffSchedulingReview(context());
 expect(requiresHumanHandoff(result)).toBe(true);
 expect(result.handoff).toMatchObject({ reason: 'scheduling_review', callbackRequested: false });
 expect(result.reply).toMatch(/not a confirmed appointment/);
 expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});
test('voice queues the review before acknowledging and propagates persistence failures', async () => {
 const c = { ...context(), channel: 'voice' };
 AlertService.createHumanHandoffAlert.mockRejectedValueOnce(new Error('database unavailable'));
 await expect(requestStaffSchedulingReview(c)).rejects.toThrow('database unavailable');
 const result = await requestStaffSchedulingReview(c);
 expect(result.outcome).toBe('callback_saved');
 expect(AlertService.createHumanHandoffAlert).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'b', conversationId: 'c', result: expect.objectContaining({ intakeReady: false }) }));
});
