import Registration from '../../src/models/a2pCustomerRegistration.js';
import Business from '../../src/models/business.js';
import { startA2pCustomerRegistration, STANDARD_CUSTOMER_PROFILE_POLICY_SID, SOLE_PROP_CUSTOMER_PROFILE_POLICY_SID } from '../../src/services/a2pCustomerOnboarding.service.js';
const inputFor = (registrationType = 'low_volume_standard') => ({
  registrationType,
  legalBusinessName: 'Fixture Plumbing',
  businessType: 'Limited Liability Corporation',
  websiteUrl: 'https://example.com',
  ...(registrationType === 'sole_proprietor' ? {} : {
    ein: '12-3456789'
  }),
  address: {
    street: '123 Example St',
    city: 'Atlanta',
    region: 'ga',
    postalCode: '30303',
    isoCountry: 'US'
  },
  contact: {
    email: 'owner@example.com',
    phone: '+14045550123',
    mobilePhone: '+14045550124',
    firstName: 'Alex',
    lastName: 'Owner'
  },
  campaign: {
    messageFlow: 'Customers explicitly consent to missed-call follow-up messages after contacting the business.',
    privacyPolicyUrl: 'https://example.com/privacy',
    termsAndConditionsUrl: 'https://example.com/terms'
  }
});
function fixture(registrationType = 'low_volume_standard') {
  const row = {
    business: 'business-fixture',
    registrationType,
    status: 'not_started',
    save: jest.fn().mockResolvedValue()
  };
  jest.spyOn(Registration, 'findOne').mockReturnValue({
    select: jest.fn().mockResolvedValue(row)
  });
  jest.spyOn(Business, 'updateOne').mockResolvedValue({
    matchedCount: 1
  });
  const profile = {
    customerProfilesEntityAssignments: {
      create: jest.fn().mockResolvedValue({})
    },
    customerProfilesEvaluations: {
      create: jest.fn().mockResolvedValue({
        status: 'compliant'
      })
    },
    update: jest.fn().mockResolvedValue({
      status: 'pending-review'
    })
  };
  const trust = {
    trustProductsEntityAssignments: {
      create: jest.fn().mockResolvedValue({})
    },
    trustProductsEvaluations: {
      create: jest.fn().mockResolvedValue({
        status: 'compliant'
      })
    },
    update: jest.fn().mockResolvedValue({
      status: 'pending-review'
    })
  };
  const profiles = Object.assign(jest.fn(() => profile), {
      create: jest.fn().mockResolvedValue({
        sid: 'BU-profile',
        status: 'draft'
      })
    }),
    trusts = Object.assign(jest.fn(() => trust), {
      create: jest.fn().mockResolvedValue({
        sid: 'BU-trust',
        status: 'draft'
      })
    });
  const endUsers = {
      create: jest.fn().mockImplementation(async ({
        type
      }) => ({
        sid: `IT-${type}`
      }))
    },
    services = Object.assign(jest.fn(), {
      create: jest.fn().mockResolvedValue({
        sid: 'MG-service'
      })
    }),
    brand = {
      create: jest.fn().mockResolvedValue({
        sid: 'BN-brand',
        status: 'PENDING'
      })
    };
  const client = {
    addresses: {
      create: jest.fn().mockResolvedValue({
        sid: 'AD-address'
      })
    },
    trusthub: {
      v1: {
        customerProfiles: profiles,
        trustProducts: trusts,
        endUsers,
        supportingDocuments: {
          create: jest.fn().mockResolvedValue({
            sid: 'RD-document'
          })
        }
      }
    },
    messaging: {
      v1: {
        services,
        brandRegistrations: brand
      }
    }
  };
  return {
    row,
    client,
    profile,
    trust,
    profiles,
    trusts,
    endUsers,
    services,
    brand
  };
}
const environment = {
  ...process.env
};
beforeEach(() => {
  process.env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID = 'BU-parent';
  process.env.A2P_NOTIFICATION_EMAIL = 'compliance@example.com';
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://example.com/';
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const key of ['TWILIO_PRIMARY_CUSTOMER_PROFILE_SID', 'A2P_NOTIFICATION_EMAIL', 'TWILIO_WEBHOOK_BASE_URL']) if (environment[key] === undefined) delete process.env[key];else process.env[key] = environment[key];
});
test.each(['standard', 'low_volume_standard', 'sole_proprietor'])('%s submits correctly and reuses resources on retry', async type => {
  const f = fixture(type),
    input = inputFor(type);
  input.address.streetSecondary = 'Unit 2';
  const result = await startA2pCustomerRegistration({
    businessId: f.row.business,
    input,
    client: f.client
  });
  expect(Registration.findOne).toHaveBeenCalledWith({
    business: f.row.business
  });
  expect(f.profiles.create).toHaveBeenCalledWith(expect.objectContaining({
    policySid: type === 'sole_proprietor' ? SOLE_PROP_CUSTOMER_PROFILE_POLICY_SID : STANDARD_CUSTOMER_PROFILE_POLICY_SID
  }));
  expect(f.profile.customerProfilesEntityAssignments.create).toHaveBeenCalledWith({
    objectSid: 'BU-parent'
  });
  expect(f.trust.trustProductsEntityAssignments.create).toHaveBeenCalledWith({
    objectSid: 'BU-profile'
  });
  expect(f.client.addresses.create).toHaveBeenCalledWith(expect.objectContaining({
    region: 'GA',
    streetSecondary: 'Unit 2'
  }));
  expect(f.services.create).toHaveBeenCalledWith(expect.objectContaining({
    inboundRequestUrl: 'https://example.com/api/twilio/sms'
  }));
  expect(f.brand.create).toHaveBeenCalledWith(expect.objectContaining({
    a2PProfileBundleSid: 'BU-trust',
    customerProfileBundleSid: 'BU-profile'
  }));
  if (type === 'sole_proprietor') {
    expect(f.brand.create.mock.calls[0][0]).toHaveProperty('brandType', 'SOLE_PROPRIETOR');
    expect(f.row.mobilePhoneLast4).toBe('0124');
  } else {
    expect(f.row.registrationNumberLast4).toBe('6789');
    expect(f.endUsers.create).toHaveBeenCalledWith(expect.objectContaining({
      attributes: expect.objectContaining({
        business_registration_number: '123456789'
      })
    }));
    expect(Boolean(f.brand.create.mock.calls[0][0].skipAutomaticSecVet)).toBe(type === 'low_volume_standard');
  }
  expect(result).toMatchObject({
    status: 'brand_pending',
    smsReady: false
  });
  expect(result).not.toHaveProperty('brandSid');
  expect(JSON.stringify(result)).not.toContain('123456789');
  const submittedAt = f.row.submittedAt;
  await startA2pCustomerRegistration({
    businessId: f.row.business,
    input,
    client: f.client
  });
  expect(f.row.submittedAt).toBe(submittedAt);
  for (const create of [f.profiles.create, f.trusts.create, f.client.addresses.create, f.services.create, f.brand.create]) expect(create).toHaveBeenCalledTimes(1);
  expect(f.profile.customerProfilesEvaluations.create).toHaveBeenCalledTimes(1);
  expect(f.trust.trustProductsEvaluations.create).toHaveBeenCalledTimes(1);
});
test.each(['standard', 'sole_proprietor'])('%s noncompliant profile blocks the brand and permits a safe retry', async type => {
  const f = fixture(type),
    input = inputFor(type);
  f.profile.customerProfilesEvaluations.create.mockResolvedValueOnce({
    status: 'noncompliant',
    results: [{
      passed: false,
      failureReason: 'Private provider rejection'
    }]
  });
  await expect(startA2pCustomerRegistration({
    businessId: f.row.business,
    input,
    client: f.client
  })).rejects.toMatchObject({
    code: 'A2P_CUSTOMER_PROFILE_NONCOMPLIANT'
  });
  expect(f.row).toMatchObject({
    status: 'action_required',
    customerProfileSid: 'BU-profile'
  });
  expect(f.row.lastError).toContain('Private provider rejection');
  expect(f.brand.create).not.toHaveBeenCalled();
  await startA2pCustomerRegistration({
    businessId: f.row.business,
    input,
    client: f.client
  });
  expect(f.profiles.create).toHaveBeenCalledTimes(1);
  expect(f.row).toMatchObject({
    status: 'brand_pending',
    lastError: ''
  });
});
test.each(['standard', 'sole_proprietor'])('%s trust evaluation failure blocks messaging resources', async type => {
  const f = fixture(type);
  f.trust.trustProductsEvaluations.create.mockResolvedValue({
    status: 'noncompliant'
  });
  await expect(startA2pCustomerRegistration({
    businessId: f.row.business,
    input: inputFor(type),
    client: f.client
  })).rejects.toMatchObject({
    code: 'A2P_TRUST_PRODUCT_NONCOMPLIANT'
  });
  expect(f.row.status).toBe('action_required');
  expect(f.brand.create).not.toHaveBeenCalled();
  expect(f.services.create).not.toHaveBeenCalled();
});
test.each([['standard', 409], ['sole_proprietor', 20409]])('%s tolerates only duplicate-parent status %s', async (type, code) => {
  const f = fixture(type);
  f.profile.customerProfilesEntityAssignments.create.mockImplementation(async ({
    objectSid
  }) => {
    if (objectSid === 'BU-parent') throw Object.assign(new Error('Already assigned'), {
      code
    });
    return {};
  });
  await expect(startA2pCustomerRegistration({
    businessId: f.row.business,
    input: inputFor(type),
    client: f.client
  })).resolves.toMatchObject({
    status: 'brand_pending'
  });
  expect(f.profile.update).toHaveBeenCalledWith({
    status: 'pending-review'
  });
});
test.each(['standard', 'sole_proprietor'])('%s preserves unexpected assignment errors', async type => {
  const f = fixture(type),
    error = Object.assign(new Error('Provider unavailable'), {
      status: 503
    });
  f.profile.customerProfilesEntityAssignments.create.mockImplementation(async ({
    objectSid
  }) => {
    if (objectSid === 'BU-parent') throw error;
    return {};
  });
  await expect(startA2pCustomerRegistration({
    businessId: f.row.business,
    input: inputFor(type),
    client: f.client
  })).rejects.toBe(error);
  expect(f.profile.update).not.toHaveBeenCalled();
  expect(f.row.status).toBe('action_required');
});
test.each([['standard', x => {
  x.address.isoCountry = 'CA';
}, /U.S. EIN/], ['standard', x => {
  x.ein = '123';
}, /9-digit EIN/], ['standard', x => {
  x.businessType = 'unrecognized';
}, /legal business type/], ['standard', x => {
  x.websiteUrl = 'invalid';
}, /website URL/], ['standard', x => {
  x.contact.firstName = '';
}, /representative first and last/], ['sole_proprietor', x => {
  x.contact.mobilePhone = 'invalid';
}, /mobile number/], ['sole_proprietor', x => {
  x.ein = '123456789';
}, /Businesses with an EIN/], ['sole_proprietor', x => {
  x.contact.lastName = '';
}, /Owner first and last/]])('%s validates details before any provider create (%#)', async (type, mutate, message) => {
  const f = fixture(type),
    input = inputFor(type);
  mutate(input);
  await expect(startA2pCustomerRegistration({
    businessId: f.row.business,
    input,
    client: f.client
  })).rejects.toThrow(message);
  expect(f.profiles.create).not.toHaveBeenCalled();
  expect(f.row.status).toBe('action_required');
  expect(f.row.save).toHaveBeenCalled();
});
test('an existing brand prevents changing registration type without any save', async () => {
  const f = fixture('standard');
  f.row.brandSid = 'BN-existing';
  await expect(startA2pCustomerRegistration({
    businessId: f.row.business,
    input: inputFor('sole_proprietor'),
    client: f.client
  })).rejects.toThrow(/type cannot be changed/);
  expect(f.row.save).not.toHaveBeenCalled();
  expect(f.brand.create).not.toHaveBeenCalled();
});
