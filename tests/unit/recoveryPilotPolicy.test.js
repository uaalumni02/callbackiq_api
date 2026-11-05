import { isPilotBusiness } from '../../src/services/recoveryCoordinator/recoveryPilotPolicy.js';

const originalPilots = process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS;
afterAll(() => {
  if (originalPilots === undefined) delete process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS;
  else process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS = originalPilots;
});

test('tenant selection exactly matches reviewed pilot IDs', () => {
  process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS = ' 507f1f77bcf86cd799439011 , 507f1f77bcf86cd799439012 ';
  expect(isPilotBusiness('507f1f77bcf86cd799439011')).toBe(true);
  expect(isPilotBusiness('507f1f77bcf86cd799439012')).toBe(true);
  expect(isPilotBusiness('507f1f77bcf86cd79943901')).toBe(false);
  expect(isPilotBusiness('507f1f77bcf86cd799439013')).toBe(false);
});

test('a populated object ID has the same matching semantics as the previous coordinator', () => {
  process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS = '507f1f77bcf86cd799439011';
  expect(isPilotBusiness({ _id: '507f1f77bcf86cd799439011' })).toBe(true);
  expect(isPilotBusiness({ _id: '507f1f77bcf86cd799439012' })).toBe(false);
});

test('unset, empty, and malformed tenant inputs cannot implicitly enable pilot', () => {
  delete process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS;
  expect(isPilotBusiness('507f1f77bcf86cd799439011')).toBe(false);
  process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS = '  ,  ,   ';
  expect(isPilotBusiness('')).toBe(false);
  expect(isPilotBusiness(null)).toBe(false);
});
