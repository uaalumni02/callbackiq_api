import { logOperationalEvent } from '../../src/helpers/logging/safeLogger.js';
jest.mock('../../src/helpers/logging/safeLogger.js', () => ({ logOperationalEvent: jest.fn() }));
import CallLog from "../../src/models/callLog.js";
import { processTwilioCallStatus } from "../../src/services/twilioCallStatus.service.js";

jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: { emitCallUpdated: jest.fn() },
}));

describe("Twilio call status transitions", () => {
  beforeEach(() => jest.clearAllMocks());

  test.each(['completed', 'in-progress', 'answered'])('%s does not claim the business answered a recovered call', async status => {
    CallLog.findOneAndUpdate.mockResolvedValue({ _id: 'call-1', status: 'missed', disposition: 'missed' });
    await processTwilioCallStatus({ businessId: 'business-1', payload: { CallSid: 'CA123', CallStatus: status, CallDuration: '42' } });
    const [filter, update] = CallLog.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ business: 'business-1', providerCallId: 'CA123' });
    expect(update.$set).toEqual({ providerStatus: status });
    expect(update.$max).toEqual({ durationSeconds: 42 });
    expect(update.$push.providerStatusEvents.$each[0]).toMatchObject({ providerStatus: status, applied: false });
  });

  test('negative parent callbacks cannot overwrite verified AI or staff answers', async () => {
    CallLog.findOneAndUpdate.mockResolvedValue({ _id: 'call-1' });
    await processTwilioCallStatus({ businessId: 'business-1', payload: { CallSid: 'CA123', CallStatus: 'no-answer', CallDuration: 'invalid' } });
    const [filter, update] = CallLog.findOneAndUpdate.mock.calls[0];
    expect(filter.disposition.$nin).toEqual(['answered_by_business', 'answered_by_ai']);
    expect(update.$max.durationSeconds).toBe(0);
  });

  test("records a conflicting terminal status without overwriting the winner", async () => {
    CallLog.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "call-1", status: "answered" });
    await processTwilioCallStatus({
      businessId: "business-1",
      payload: { CallSid: "CA123", CallStatus: "no-answer" },
    });
    const conflictEvent = CallLog.findOneAndUpdate.mock.calls[1][1].$push.providerStatusEvents.$each[0];
    expect(conflictEvent).toMatchObject({ applied: false, conflict: true });
  });
});

test('unknown callback leaves a business-scoped diagnostic', async () => {
  CallLog.findOneAndUpdate.mockResolvedValue(null);
  await processTwilioCallStatus({ businessId: 'business-1', payload: { CallSid: 'CA_UNKNOWN', CallStatus: 'completed' } });
  expect(logOperationalEvent).toHaveBeenCalledWith('twilio.status.unknown_call', expect.objectContaining({ businessId: 'business-1', providerCallId: 'CA_UNKNOWN' }));
});
