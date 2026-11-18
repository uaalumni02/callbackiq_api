import Db from '../../src/db/db.js';
import requireSubscriptionAccess from '../../src/middleware/require-subscription-access.js';
import { ACCESS_LEVELS } from '../../src/services/subscriptionAccess.service.js';

jest.mock('../../src/db/db.js', () => ({
  __esModule: true,
  default: { getBusinessScopeByOwner: jest.fn(), getBusinessByOwner: jest.fn(), getSubscriptionByBusiness: jest.fn() },
}));

const business = { _id: 'business-id' };
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
beforeEach(() => jest.resetAllMocks());

test.each([
  [ACCESS_LEVELS.FULL, undefined, 403, 'Active subscription required'],
  [ACCESS_LEVELS.FULL, { status: 'past_due' }, 403, 'Your subscription is not active'],
  [ACCESS_LEVELS.READ_ONLY, { status: 'expired' }, undefined, undefined],
  [ACCESS_LEVELS.READ_ONLY, { status: 'incomplete' }, 403, 'Subscription access is unavailable'],
  [ACCESS_LEVELS.BILLING_ONLY, { status: 'incomplete' }, undefined, undefined],
  [ACCESS_LEVELS.BILLING_ONLY, { status: 'unexpected' }, 403, 'Subscription access is unavailable'],
])('%s access for %j', async (level, subscription, status, message) => {
  Db.getSubscriptionByBusiness.mockResolvedValue(subscription);
  const res = response();
  const next = jest.fn();
  await requireSubscriptionAccess(level)({ business }, res, next);
  if (status) {
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message }));
    expect(next).not.toHaveBeenCalled();
  } else {
    expect(next).toHaveBeenCalledTimes(1);
  }
});

test('setup authorization is explicit and owner lookup retains tenant scope', async () => {
  Db.getBusinessScopeByOwner.mockResolvedValue(business);
  Db.getSubscriptionByBusiness.mockResolvedValue({ status: 'incomplete' });
  const allowSetup = jest.fn().mockReturnValue(true);
  const req = { user: { userId: 'owner-id' } };
  const next = jest.fn();
  await requireSubscriptionAccess(undefined, { allowSetup })(req, response(), next);
  expect(Db.getBusinessScopeByOwner).toHaveBeenCalledWith(expect.any(Function), 'owner-id');
  expect(allowSetup).toHaveBeenCalledWith(req, req.subscription);
  expect(next).toHaveBeenCalledTimes(1);
});

test('missing tenant and repository errors fail closed', async () => {
  const denied = response();
  const failed = response();
  const next = jest.fn();
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await requireSubscriptionAccess()({}, denied, next);
    Db.getSubscriptionByBusiness.mockRejectedValue(new Error('synthetic database failure'));
    await requireSubscriptionAccess()({ business }, failed, next);
    expect(denied.status).toHaveBeenCalledWith(400);
    expect(failed.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
