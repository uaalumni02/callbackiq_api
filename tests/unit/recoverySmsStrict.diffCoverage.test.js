import CallLog from '../../src/models/callLog.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
import { claimRecoveryIntroduction } from '../../src/services/messaging/recoveryIntroduction.service.js';
import { deliverRecoveryIntroduction } from '../../src/services/twilioSmsWebhook.service.js';
import SocketService from '../../src/services/socket.service.js';
import { logOperationalError } from '../../src/helpers/logging/safeLogger.js';
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
jest.mock('../../src/services/messaging/recoveryIntroduction.service.js', () => ({ claimRecoveryIntroduction: jest.fn() }));
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({ logOperationalError: jest.fn(), logOperationalEvent: jest.fn(), logOperationalWarning: jest.fn(), safeConsole: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const context = () => ({ business: { _id: 'b1', phone: '+14045550100' }, conversation: { _id: 'c1' }, lead: { _id: 'l1' }, callLog: { _id: 'call1' }, callSid: 'CA_TEST', customerPhone: '+14045550101', starterText: 'What service do you need?', smsEnabled: true, smsStatus: 'queued' });
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
test('strict durable processing propagates provider failure without marking a message sent', async () => {
  const error = Object.assign(new Error('provider unavailable'), { code: 'ETIMEDOUT' });
  claimRecoveryIntroduction.mockResolvedValue(true); sendSms.mockRejectedValue(error);
  const update = jest.spyOn(CallLog, 'findByIdAndUpdate');
  await expect(deliverRecoveryIntroduction({ ...context(), strict: true })).rejects.toBe(error);
  expect(claimRecoveryIntroduction).toHaveBeenCalledWith({ businessId: 'b1', conversationId: 'c1', operationKey: 'CA_TEST' });
  expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ metadata: { providerCallSid: 'CA_TEST', idempotencyKey: 'missed-call-recovery:b1:CA_TEST' } }));
  expect(update).not.toHaveBeenCalled();
  expect(logOperationalError).not.toHaveBeenCalled(); // The durable worker owns retry/error handling.
});
test('legacy synchronous handling records provider failure without throwing into the voice response', async () => {
  const error = Object.assign(new Error('recipient opted out'), { code: 21610 });
  claimRecoveryIntroduction.mockResolvedValue(true); sendSms.mockRejectedValue(error);
  const update = jest.spyOn(CallLog, 'findByIdAndUpdate').mockResolvedValue({ _id: 'call1', missedCallTextSent: false });
  jest.spyOn(SocketService, 'emitCallUpdated').mockImplementation(() => {});
  jest.spyOn(SocketService, 'emitDashboardRefresh').mockImplementation(() => {});
  await expect(deliverRecoveryIntroduction(context())).resolves.toBe('queued');
  expect(claimRecoveryIntroduction).toHaveBeenCalledWith({ businessId: 'b1', conversationId: 'c1', operationKey: '' });
  expect(logOperationalError).toHaveBeenCalledWith('twilio.voice.sms_failed', error, expect.objectContaining({ errorCode: 21610 }));
  expect(update).toHaveBeenCalledWith('call1', expect.objectContaining({ missedCallTextSent: false, smsProviderMessageId: '' }), expect.any(Object));
});
