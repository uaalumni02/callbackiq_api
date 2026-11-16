import User from '../../src/models/user.js';
import requireAdmin from '../../src/middleware/require-admin.js';
import { invoiceTotals } from '../../src/services/admin/invoiceAllocation.policy.js';
import { normalizePhone, validateCommon, validateAddress, formatEvaluationFailure } from '../../src/services/a2pRegistrationInput.policy.js';
import { stageCanceledAppointment, stageStaffAppointmentOutcome } from '../../src/services/stateTransitions/appointmentCommands.js';
import { opportunityValuationReserveValuationLeadAtomicUpdate, opportunityValuationReserveValuationLeadAtomicUpdate2 } from '../../src/services/stateTransitions/customerProjections.js';
import { googleCalendarChangeReviewApproveMoveAppointmentAtomicUpdate } from '../../src/services/stateTransitions/integrations.js';
afterEach(() => jest.restoreAllMocks());
const response = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
test.each([[undefined, 'admin', 401], [{
  userId: 'u',
  mfaVerified: false,
  authTime: 999
}, 'admin', 401], [{
  userId: 'u',
  mfaVerified: true
}, 'admin', 401], [{
  userId: 'u',
  mfaVerified: true,
  authTime: 'invalid'
}, 'admin', 401], [{
  userId: 'u',
  mfaVerified: true,
  authTime: 1001
}, 'admin', 401], [{
  userId: 'u',
  mfaVerified: true,
  authTime: 99
}, 'admin', 401], [{
  userId: 'u',
  mfaVerified: true,
  authTime: 999
}, null, 403], [{
  userId: 'u',
  mfaVerified: true,
  authTime: 999
}, {}, 403]])('privileged writes reject missing, stale, malformed, future or unowned authority (%#)', async (claims, role, status) => {
  jest.spyOn(Date, 'now').mockReturnValue(1000000);
  jest.spyOn(User, 'findById').mockReturnValue({
    select: () => ({
      lean: async () => role === null ? null : typeof role === 'object' ? role : {
        role
      }
    })
  });
  const res = response(),
    next = jest.fn();
  await requireAdmin({
    method: 'POST',
    user: claims
  }, res, next);
  expect(res.status).toHaveBeenCalledWith(status);
  expect(next).not.toHaveBeenCalled();
});
test('a recent MFA administrator may write, while a database outage fails closed', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1000000);
  const query = jest.spyOn(User, 'findById').mockReturnValue({
    select: () => ({
      lean: async () => ({
        role: 'admin'
      })
    })
  });
  const req = {
      method: 'POST',
      user: {
        userId: 'u',
        mfaVerified: true,
        authTime: 999
      }
    },
    next = jest.fn();
  await requireAdmin(req, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
  query.mockImplementation(() => {
    throw new Error('unavailable');
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const res = response();
  await requireAdmin(req, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(500);
});
test.each([['4045550123', '+14045550123'], ['14045550123', '+14045550123'], ['24445550123', '']])('onboarding phone normalization handles %s', (value, expected) => expect(normalizePhone(value)).toBe(expected));
test('provider evaluation diagnostics preserve supported field names and ignore passing entries', () => {
  expect(formatEvaluationFailure({
    results: [{
      passed: false,
      failure_reason: 'snake'
    }, {
      passed: false,
      friendlyName: 'camel'
    }, {
      passed: false,
      friendly_name: 'legacy'
    }, {
      passed: true
    }, null]
  })).toBe('snake | camel | legacy');
  expect(formatEvaluationFailure({
    results: 'invalid'
  })).toMatch(/noncompliant/);
});
test('default registration type and missing/invalid input boundaries remain compatible', () => {
  const input = {
    legalBusinessName: 'Fixture Business',
    contact: {
      email: ' OWNER@example.com ',
      phone: '4045550123'
    },
    campaign: {
      messageFlow: 'Customers consent to follow-up SMS after contacting the business directly.',
      privacyPolicyUrl: 'https://example.com/privacy',
      termsAndConditionsUrl: 'https://example.com/terms'
    }
  };
  expect(validateCommon(input)).toMatchObject({
    registrationType: 'low_volume_standard',
    contactEmail: 'owner@example.com',
    contactPhone: '+14045550123'
  });
  expect(() => validateCommon()).toThrow(/Legal business/);
  expect(() => validateCommon({
    ...input,
    contact: null
  })).toThrow(/contact email/);
  expect(() => validateCommon({
    ...input,
    contact: {
      email: 'owner@example.com'
    }
  })).toThrow(/contact phone/);
  expect(() => validateCommon({
    ...input,
    campaign: undefined
  })).toThrow(/consent/);
  expect(() => validateAddress()).toThrow(/Street/);
  const address = {
    street: 'Street',
    city: 'City',
    region: 'ga',
    postalCode: '30303'
  };
  expect(validateAddress(address).isoCountry).toBe('US');
  expect(() => validateAddress({
    ...address,
    isoCountry: 'GB'
  })).toThrow(/US and Canadian/);
  for (const key of ['street', 'city', 'region', 'postalCode']) expect(() => validateAddress({
    ...address,
    [key]: ''
  })).toThrow(/required/);
});
test('cash and overdue totals treat absent amounts as zero and reject missing/future due dates', () => {
  const start = new Date('2026-11-01'),
    end = new Date('2026-11-11');
  const facts = [{
    livemode: true,
    currency: 'usd',
    status: 'paid',
    recurring: false,
    paidAt: '2026-11-03'
  }, {
    livemode: true,
    currency: 'usd',
    status: 'open',
    dueAt: null
  }, {
    livemode: true,
    currency: 'usd',
    status: 'open',
    dueAt: '2026-11-20',
    amountRemainingCents: 500
  }, {
    livemode: true,
    currency: 'usd',
    status: 'open',
    dueAt: '2026-11-04'
  }];
  expect(invoiceTotals(facts, start, end)).toEqual({
    cashCents: 0,
    allocatedCents: 0,
    overdueCents: 0
  });
});
test('recurring invoice allocation preserves overlap rounding and incomplete evidence', () => {
  const start = new Date('2026-11-01'),
    end = new Date('2026-11-11'),
    invoice = {
      livemode: true,
      currency: 'usd',
      status: 'paid',
      recurring: true,
      paidAt: '2026-11-03',
      amountPaidCents: 1001,
      allocatableCents: 1001,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-21'
    };
  expect(invoiceTotals([invoice], start, end)).toEqual({
    cashCents: 1001,
    allocatedCents: 501,
    overdueCents: 0
  });
  expect(invoiceTotals([invoice, {
    ...invoice,
    periodStart: 'invalid'
  }], start, end).allocatedCents).toBeNull();
  expect(invoiceTotals([{
    ...invoice,
    paidAt: end
  }], start, end).cashCents).toBe(0);
});
test('repeated cancellations and staff outcomes are idempotent; illegal outcomes cannot mutate state', () => {
  const canceled = {
      status: 'canceled'
    },
    completed = {
      status: 'completed'
    };
  expect(stageCanceledAppointment({
    appointment: canceled
  })).toBe('canceled');
  expect(stageStaffAppointmentOutcome({
    appointment: completed,
    changes: {
      status: 'completed'
    }
  })).toBe('completed');
  const original = {
    status: 'confirmed'
  };
  expect(() => stageStaffAppointmentOutcome({
    appointment: original,
    changes: {
      status: 'canceled'
    }
  })).toThrow(TypeError);
  expect(original.status).toBe('confirmed');
  expect(() => stageStaffAppointmentOutcome({
    appointment: canceled,
    changes: {
      status: 'completed'
    }
  })).toThrow(/Invalid appointment transition/);
  expect(canceled.status).toBe('canceled');
});
test('legacy valuation callers retain tenant-scoped lazy reservations without an observed document', () => {
  const query = {},
    Lead = {
      findOneAndUpdate: jest.fn(() => query)
    },
    lead = {
      _id: 'lead'
    };
  expect(opportunityValuationReserveValuationLeadAtomicUpdate({
    Lead,
    businessId: 'tenant',
    lead,
    unknownEstimate: () => ({
      valuation: {
        source: 'unknown'
      }
    })
  })).toBe(query);
  expect(Lead.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
    _id: 'lead',
    business: 'tenant'
  });
  expect(opportunityValuationReserveValuationLeadAtomicUpdate2({
    Lead,
    businessId: 'tenant',
    lead
  })).toBe(query);
  expect(Lead.findOneAndUpdate.mock.calls[1][0]).toMatchObject({
    _id: 'lead',
    business: 'tenant'
  });
});
test.each([false, true])('provider move approval preserves current and legacy observed-state claims (%s)', modern => {
  const query = {},
    Appointment = {
      findOneAndUpdate: jest.fn(() => query)
    },
    updatedAt = new Date('2026-11-01'),
    startAt = new Date('2026-11-16T12:00:00Z'),
    endAt = new Date('2026-11-16T13:00:00Z');
  const appointment = {
    _id: 'appointment',
    status: 'confirmed',
    ...(modern ? {
      stateVersion: 7,
      updatedAt
    } : {})
  };
  expect(googleCalendarChangeReviewApproveMoveAppointmentAtomicUpdate({
    Appointment,
    appointment,
    business: {
      _id: 'tenant'
    },
    capacityLane: 1,
    change: {
      eventId: 'event',
      calendarId: 'calendar'
    },
    startAt,
    endAt,
    getSlotClaimKeys: () => ['slot']
  })).toBe(query);
  const filter = Appointment.findOneAndUpdate.mock.calls[0][0];
  expect(filter).toMatchObject({
    _id: 'appointment',
    business: 'tenant',
    status: 'confirmed',
    stateVersion: modern ? 7 : {
      $in: [0, null]
    },
    'rescheduleIntent.key': {
      $exists: false
    },
    'confirmationIntent.status': {
      $ne: 'pending_provider'
    }
  });
  if (modern) expect(filter.updatedAt).toBe(updatedAt);else expect(filter).not.toHaveProperty('updatedAt');
});
