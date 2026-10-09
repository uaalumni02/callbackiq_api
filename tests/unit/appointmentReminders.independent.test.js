import IntegrationConnection from '../../src/models/integrationConnection.js';
import SchedulingPolicy from '../../src/models/schedulingPolicy.js';
import Job from '../../src/models/appointmentNotificationJob.js';
import { getGoogleSettings } from '../../src/services/integrations/integrationSettings.service.js';
import { scheduleAppointmentReminders, schedulePostAppointmentFollowUp, scheduleAppointmentChangeNotice } from '../../src/services/scheduling/appointmentNotification.service.js';
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
jest.mock('../../src/services/integrations/integrationSettings.service.js', () => ({ getGoogleSettings: jest.fn() }));
const appointment = { _id: 'appointment', business: 'business', status: 'confirmed', startAt: new Date(Date.now() + 72 * 3600000) };
beforeEach(() => {
  jest.spyOn(IntegrationConnection, 'findOne').mockResolvedValue(null);
  jest.spyOn(SchedulingPolicy, 'findOne').mockReturnValue({ lean: async () => ({ customerRemindersEnabled: true, reminderHours: [24, 2] }) });
  jest.spyOn(Job, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
  jest.spyOn(Job, 'findOneAndUpdate').mockResolvedValue({});
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
test('internal calendar creates configured reminders with no Google connection', async () => {
  await scheduleAppointmentReminders({ appointment });
  expect(Job.findOneAndUpdate).toHaveBeenCalledTimes(2);
  expect(Job.findOneAndUpdate.mock.calls.map(call => call[0].key)).toEqual(['reminder:24', 'reminder:2']);
});
test('explicit off overrides legacy Google reminders', async () => {
  IntegrationConnection.findOne.mockResolvedValue({});
  getGoogleSettings.mockReturnValue({ customerRemindersEnabled: true });
  SchedulingPolicy.findOne.mockReturnValue({ lean: async () => ({ customerRemindersEnabled: false }) });
  expect(await scheduleAppointmentReminders({ appointment })).toEqual([]);
  expect(Job.findOneAndUpdate).not.toHaveBeenCalled();
});
test('unspecified preferences preserve existing Google settings', async () => {
  IntegrationConnection.findOne.mockResolvedValue({});
  getGoogleSettings.mockReturnValue({ customerRemindersEnabled: true, reminderHours: [12] });
  SchedulingPolicy.findOne.mockReturnValue({ lean: async () => null });
  await scheduleAppointmentReminders({ appointment });
  expect(Job.findOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(Job.findOneAndUpdate.mock.calls[0][0].key).toBe('reminder:12');
});
test('internal after-visit follow-up uses business preference', async () => {
  SchedulingPolicy.findOne.mockReturnValue({ lean: async () => ({ postAppointmentFollowUpEnabled: true, postAppointmentFollowUpDelayHours: 3 }) });
  const completedAt = new Date();
  await schedulePostAppointmentFollowUp({ appointment: { ...appointment, status: 'completed', completedAt } });
  expect(Job.findOneAndUpdate.mock.calls[0][1].$setOnInsert.scheduledFor).toEqual(new Date(+completedAt + 3 * 3600000));
});
test('lifecycle notice retries do not reset accepted or uncertain delivery evidence', async () => {
  await scheduleAppointmentChangeNotice({ appointment, key: 'lifecycle_canceled', body: 'Canceled' });
  expect(Job.findOneAndUpdate.mock.calls[0][1]).toHaveProperty('$setOnInsert');
  expect(Job.findOneAndUpdate.mock.calls[0][1]).not.toHaveProperty('$set');
});
