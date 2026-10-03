import Appointment from '../../src/models/appointment.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import Alert from '../../src/models/alert.js';
import AlertService from '../../src/services/alert.service.js';
import { submitRescheduleRequest, ensureRescheduleReview } from '../../src/services/scheduling/rescheduleRequest.service.js';
import { lifecycleMarker, repairAppointmentLifecycle, tryRepairAppointmentLifecycle, declineRescheduleRequest } from '../../src/services/scheduling/appointmentLifecycle.service.js';
import { pendingApprovalFilter } from '../../src/services/scheduling/appointmentList.service.js';
import { scheduleAppointmentChangeNotice, cancelAppointmentNotifications, scheduleAppointmentReminders } from '../../src/services/scheduling/appointmentNotification.service.js';

jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: { emitToBusiness: jest.fn() } }));
jest.mock('../../src/services/scheduling/appointmentNotification.service.js', () => ({ scheduleAppointmentChangeNotice: jest.fn(), cancelAppointmentNotifications: jest.fn(), scheduleAppointmentReminders: jest.fn() }));
const business = { _id: '64b000000000000000000001', businessName: 'Test shop', timezone: 'America/New_York' };
const startAt = new Date('2030-01-02T15:00:00Z'), endAt = new Date('2030-01-02T16:00:00Z');
const row = overrides => ({ _id: '64b000000000000000000002', business: business._id, conversation: '64b000000000000000000003', lead: '64b000000000000000000004', status: 'confirmed', startAt, endAt, timezone: business.timezone, ...overrides });
const query = value => ({ lean: async () => value });
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Appointment, 'updateOne').mockResolvedValue({ matchedCount: 1 });
  jest.spyOn(Conversation, 'updateOne').mockResolvedValue({ matchedCount: 1 });
  jest.spyOn(Lead, 'updateOne').mockResolvedValue({ matchedCount: 1 });
  jest.spyOn(Alert, 'updateMany').mockResolvedValue({ matchedCount: 1 });
  jest.spyOn(Business, 'findById').mockReturnValue(query(business));
  jest.spyOn(AlertService, 'create').mockResolvedValue({ alert: { _id: 'review' } });
  scheduleAppointmentChangeNotice.mockResolvedValue({ _id: 'notice', status: 'scheduled' });
});
afterEach(() => jest.restoreAllMocks());

test('reschedule persists a tenant-scoped request before strict actionable alert creation', async () => {
  const appointment = row({ rescheduleRequest: { id: 'request', status: 'pending', startAt, endAt, alertPending: true } });
  jest.spyOn(Appointment, 'findOne').mockReturnValueOnce(query(row({}))).mockReturnValue(query(appointment));
  jest.spyOn(Appointment, 'findOneAndUpdate').mockReturnValue(query(appointment));
  await submitRescheduleRequest({ business, appointmentId: appointment._id, conversationId: appointment.conversation, startAt, endAt, channel: 'sms' });
  expect(Appointment.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ business: business._id, status: 'confirmed' }), expect.objectContaining({ $set: expect.objectContaining({ rescheduleRequest: expect.objectContaining({ status: 'pending', alertPending: true }) }) }), expect.anything());
  expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({ actionRequired: true, appointmentId: appointment._id, conversationId: appointment.conversation, metadata: expect.objectContaining({ approvalRequest: true, rescheduleRequest: true }) }));
  expect(Appointment.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(AlertService.create.mock.invocationCallOrder[0]);
});

test('missing alert evidence rejects submission and leaves the repair marker', async () => {
  const appointment = row({ rescheduleRequest: { id: 'request', status: 'pending', startAt, endAt, alertPending: true } });
  AlertService.create.mockResolvedValue({ alert: null, created: false });
  await expect(ensureRescheduleReview(appointment)).rejects.toThrow(/could not be saved/);
  expect(Appointment.updateOne).not.toHaveBeenCalled();
});

test('foreign conversation cannot submit a change', async () => {
  jest.spyOn(Appointment, 'findOne').mockReturnValue(query(null));
  await expect(submitRescheduleRequest({ business, appointmentId: 'foreign', conversationId: 'other', startAt, endAt })).rejects.toMatchObject({ statusCode: 409 });
  expect(AlertService.create).not.toHaveBeenCalled();
});

test('approval list includes both held requests and confirmed appointments with pending changes', () => {
  expect(pendingApprovalFilter().$or).toContainEqual({ status: 'confirmed', 'rescheduleRequest.status': 'pending' });
  expect(pendingApprovalFilter().$or[0]).toMatchObject({ requiresBusinessApproval: true, approvalDecisionAt: null });
});

test.each(['confirmed', 'canceled', 'declined'])('%s notice is queued before its recovery marker is cleared', async event => {
  const appointment = row({ status: event === 'declined' ? 'failed' : event, lifecycleNotice: lifecycleMarker(event) });
  await repairAppointmentLifecycle(appointment, business);
  expect(scheduleAppointmentChangeNotice).toHaveBeenCalledWith(expect.objectContaining({ key: `lifecycle_${event}`, body: expect.stringContaining('Test shop') }));
  expect(Appointment.updateOne).toHaveBeenLastCalledWith(expect.objectContaining({ 'lifecycleNotice.key': `lifecycle_${event}` }), { $set: { 'lifecycleNotice.pending': false, 'lifecycleNotice.lastError': '' } });
});

test('a notice queue failure preserves durable retry work rather than failing the appointment decision', async () => {
  scheduleAppointmentChangeNotice.mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(tryRepairAppointmentLifecycle(row({ lifecycleNotice: lifecycleMarker('confirmed') }), business)).resolves.toBeUndefined();
  expect(Appointment.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: { 'lifecycleNotice.lastError': 'queue unavailable' } });
  expect(Appointment.updateOne).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ 'lifecycleNotice.pending': false }) }));
});

test('reschedule repair moves only the conversation still linked to the original appointment', async () => {
  const old = row({ status: 'rescheduled', rescheduledTo: 'replacement' });
  const replacement = row({ _id: 'replacement', rescheduledFrom: old._id, lifecycleNotice: lifecycleMarker('rescheduled') });
  jest.spyOn(Appointment, 'findOne').mockReturnValue(query(old));
  await repairAppointmentLifecycle(replacement, business);
  expect(Conversation.updateOne).toHaveBeenCalledWith(expect.objectContaining({ business: business._id, 'bookingState.appointment': old._id }), expect.objectContaining({ $set: expect.objectContaining({ 'bookingState.appointment': 'replacement', 'bookingState.status': 'booked' }) }));
  expect(cancelAppointmentNotifications).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: old._id }));
  expect(scheduleAppointmentReminders).toHaveBeenCalledWith({ appointment: replacement });
  expect(scheduleAppointmentChangeNotice.mock.calls[0][0].body).toMatch(/replaces your previous/);
});

test('declining a change is replayable without canceling the existing appointment', async () => {
  const appointment = row({ rescheduleRequest: { id: 'request', status: 'declined' }, lifecycleNotice: lifecycleMarker('change_declined_request') });
  jest.spyOn(Appointment, 'findOneAndUpdate').mockResolvedValue(null);
  jest.spyOn(Appointment, 'findOne').mockResolvedValue(appointment);
  const result = await declineRescheduleRequest({ business, appointmentId: appointment._id, requestId: 'request' });
  expect(result.status).toBe('confirmed');
  expect(scheduleAppointmentChangeNotice.mock.calls[0][0].body).toMatch(/existing appointment remains confirmed/);
});

test('a canceled appointment with an interrupted confirmation marker cannot relink as booked', async () => {
 await repairAppointmentLifecycle(row({status:'canceled', lifecycleNotice:lifecycleMarker('confirmed')}),business);
 expect(Conversation.updateOne).not.toHaveBeenCalled();
 expect(scheduleAppointmentChangeNotice).not.toHaveBeenCalled();
});
