import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPilotBusiness } from '../src/services/recoveryCoordinator/recoveryPilotPolicy.js';

const withPilots = (value, fn) => {
  const old = process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS;
  try {
    process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS = value;
    fn();
  } finally {
    if (old === undefined) delete process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS;
    else process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS = old;
  }
};

test('pilot eligibility is exact and tenant-scoped (not partial matching)', () => {
  withPilots(' tenant-A , tenant-B , ', () => {
    assert.equal(isPilotBusiness('tenant-A'), true);
    assert.equal(isPilotBusiness('tenant-B'), true);
    assert.equal(isPilotBusiness('tenant'), false);
    assert.equal(isPilotBusiness('tenant-C'), false);
    assert.equal(isPilotBusiness(''), false);
  });
});

test('object ids use the same value coercion as the prior coordinator', () => {
  withPilots('507f1f77bcf86cd799439011', () => {
    const tenant = { _id: { toString: () => '507f1f77bcf86cd799439011' } };
    assert.equal(isPilotBusiness(tenant), true);
    assert.equal(isPilotBusiness({ _id: '507f1f77bcf86cd799439012' }), false);
  });
});

test('empty pilot configuration never enables an arbitrary tenant', () => {
  withPilots('', () => {
    assert.equal(isPilotBusiness('507f1f77bcf86cd799439011'), false);
    assert.equal(isPilotBusiness(null), false);
  });
});
