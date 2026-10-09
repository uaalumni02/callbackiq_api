import Notice from '../../src/models/appointmentNotificationJob.js';
import Alert from '../../src/models/alert.js';
import Intervention from '../../src/services/intervention.service.js';
import Message from '../../src/models/message.js';
import Connection from '../../src/models/integrationConnection.js';
import Policy from '../../src/models/schedulingPolicy.js';
import { reconcileAppointmentNoticeFailures, recordManualNoticeContact } from '../../src/services/scheduling/appointmentNoticeFailure.service.js';
import { schedulePostAppointmentFollowUp } from '../../src/services/scheduling/appointmentNotification.service.js';
const query = value => ({ sort: () => query(value), limit: () => query(value), lean: async () => value });
let job;
beforeEach(() => {
 job = { _id: 'job', business: 'business', appointment: 'appt', status: 'failed', deliveryStatus: 'undelivered' };
 jest.spyOn(Notice, 'find').mockReturnValueOnce(query([job])).mockReturnValue(query([]));
 jest.spyOn(Notice, 'findOne').mockResolvedValue(job);
 jest.spyOn(Notice, 'updateOne').mockResolvedValue({ matchedCount: 1 });
 jest.spyOn(Alert, 'updateMany').mockResolvedValue({ modifiedCount: 1 });
 jest.spyOn(Intervention, 'create').mockResolvedValue({});
});
afterEach(() => jest.restoreAllMocks());
test('exhausted send or undelivered receipt generates a durable deduplicated staff action', async () => {
 await reconcileAppointmentNoticeFailures();
 expect(Intervention.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'message_delivery_failure', appointmentId: 'appt', dedupeKey: 'appointment_notice_failure:job' }));
});
test('manual contact is business/appointment scoped, closes failure, and never claims delivery', async () => {
 expect(await recordManualNoticeContact({ businessId: 'business', appointmentId: 'appt', jobId: 'job', userId: 'owner' })).toEqual({ resolved: true, deliveryStatus: 'undelivered' });
 expect(Notice.findOne).toHaveBeenCalledWith({ _id: 'job', business: 'business', appointment: 'appt' });
 expect(Notice.updateOne).toHaveBeenCalledWith(expect.any(Object), { $set: expect.objectContaining({ resolutionReason: 'customer_contacted', resolvedBy: 'owner' }) });
 expect(Notice.updateOne.mock.calls[0][1].$set).not.toHaveProperty('deliveryStatus');
});
test('a queued job cannot be manually resolved while it may still send', async () => {
 job.status = 'scheduled';
 await expect(recordManualNoticeContact({ businessId: 'business', appointmentId: 'appt', jobId: 'job', userId: 'owner' })).rejects.toMatchObject({ statusCode: 409 });
 expect(Notice.updateOne).not.toHaveBeenCalled();
});
test('late delivered receipt closes the existing staff incident without another message', async () => {
 Notice.find.mockReset().mockReturnValueOnce(query([])).mockReturnValueOnce(query([{ ...job, deliveryStatus: 'delivered' }]));
 await reconcileAppointmentNoticeFailures();
 expect(Alert.updateMany).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'appointment_notice_failure:job' }), expect.any(Object));
 expect(Notice.updateOne).toHaveBeenCalledWith(expect.any(Object), { $set: expect.objectContaining({ resolutionReason: 'delivered' }) });
});
test('completion replay uses insert-only follow-up work and cannot reset its sent receipt', async () => {
 jest.spyOn(Connection, 'findOne').mockResolvedValue(null);
 jest.spyOn(Policy, 'findOne').mockReturnValue(query({ postAppointmentFollowUpEnabled: true }));
 jest.spyOn(Notice, 'findOneAndUpdate').mockResolvedValue({ status: 'sent' });
 await schedulePostAppointmentFollowUp({ appointment: { _id: 'appt', business: 'business', status: 'completed', completedAt: new Date() } });
 const [filter, update] = Notice.findOneAndUpdate.mock.calls[0];
 expect(filter).toMatchObject({ key: 'follow_up', appointment: 'appt', business: 'business' });
 expect(update).toHaveProperty('$setOnInsert'); expect(update).not.toHaveProperty('$set');
});
