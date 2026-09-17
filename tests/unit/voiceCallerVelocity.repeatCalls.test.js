import VoiceCallerWindow from '../../src/models/voiceCallerWindow.js';
import AlertService from '../../src/services/alert.service.js';
import { evaluateCallerVelocity } from '../../src/services/voiceFraudDetection.service.js';

jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createSystemAlert: jest.fn() } }));
const args = { businessId: 'business-a', callerPhone: '+14045550100', providerCallSid: 'CA-current', now: new Date('2026-09-17T12:00:00Z') };
afterEach(() => jest.restoreAllMocks());

test('missing call identity fails closed before touching the admission store', async () => {
  const update = jest.spyOn(VoiceCallerWindow, 'findOneAndUpdate');
  expect(await evaluateCallerVelocity({ ...args, providerCallSid: '' })).toEqual({ allowed: false, reason: 'caller_velocity_identity_required' });
  expect(update).not.toHaveBeenCalled();
});

test('a stored tenth-call admission is honored, including replay after later calls', async () => {
  const attempts = Array.from({ length: 12 }, (_, i) => ({ key: i === 9 ? args.providerCallSid : `CA-${i}`, allowed: i < 10 }));
  jest.spyOn(VoiceCallerWindow, 'findOneAndUpdate').mockResolvedValue({ attempts });
  expect(await evaluateCallerVelocity(args)).toEqual({ allowed: true, count: 10 });
});

test('a rejected call remains rejected when retried', async () => {
  jest.spyOn(VoiceCallerWindow, 'findOneAndUpdate').mockResolvedValue({ attempts: [{ key: args.providerCallSid, allowed: false }] });
  expect(await evaluateCallerVelocity(args)).toMatchObject({ allowed: false, reason: 'caller_velocity_limit' });
});

test('a concurrent first-insert collision retries against the existing atomic document', async () => {
  const update = jest.spyOn(VoiceCallerWindow, 'findOneAndUpdate')
    .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }))
    .mockResolvedValueOnce({ attempts: [{ key: args.providerCallSid, allowed: true }] });
  expect((await evaluateCallerVelocity(args)).allowed).toBe(true);
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[1][0]).toEqual(update.mock.calls[0][0]);
  expect(update.mock.calls[1][2].upsert).toBeUndefined();
});

test('database failure propagates instead of silently admitting the caller', async () => {
  jest.spyOn(VoiceCallerWindow, 'findOneAndUpdate').mockRejectedValue(new Error('database unavailable'));
  await expect(evaluateCallerVelocity(args)).rejects.toThrow('database unavailable');
});

test('Mongoose accepts the atomic pipeline and keeps provider keys literal', async () => {
  const key = '$untrusted-call-id';
  const wire = jest.spyOn(VoiceCallerWindow.collection, 'findOneAndUpdate').mockResolvedValue({ _id: 'window', attempts: [{ key, allowed: true }] });
  expect((await evaluateCallerVelocity({ ...args, providerCallSid: key })).allowed).toBe(true);
  expect(Array.isArray(wire.mock.calls[0][1])).toBe(true);
  expect(wire.mock.calls[0][1][1].$set.attempts.$cond[0].$or[0].$in[0]).toEqual({ $literal: key });
});
