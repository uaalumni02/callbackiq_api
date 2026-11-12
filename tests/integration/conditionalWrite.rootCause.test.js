import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import { conditionalWrite } from '../../src/services/database/conditionalWrite.js';
import { expireObservedTrial } from '../../src/services/trialExpiry.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);

async function fixture() {
  const business = await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Synthetic CAS',
    businessType: 'plumbing', email: 'cas@example.test' });
  const subscription = await Subscription.create({ business: business._id, status: 'trialing',
    trialEndsAt: new Date(Date.now() - 60000), stripeCustomerId: 'cus_cas', stripeSubscriptionId: 'sub_cas' });
  return { business, subscription };
}

test('one claimant applies and stale completions reload the winning scoped state', async () => {
  const { business, subscription } = await fixture();
  const input = { model: Subscription, identity: { _id: subscription._id, business: business._id },
    observed: { status: 'trialing', trialEndsAt: subscription.trialEndsAt },
    update: { $set: { status: 'expired', isActive: false } } };
  const results = await Promise.all(Array.from({ length: 8 }, () => conditionalWrite(input)));
  expect(results.filter(result => result.applied)).toHaveLength(1);
  expect(results.every(result => result.current.status === 'expired')).toBe(true);
});

test('a wrong business cannot read or complete a different tenant document', async () => {
  const { subscription } = await fixture();
  const result = await conditionalWrite({ model: Subscription,
    identity: { _id: subscription._id, business: new mongoose.Types.ObjectId() },
    observed: { status: 'trialing' }, update: { $set: { status: 'expired' } } });
  expect(result).toEqual({ applied: false, current: null });
  expect((await Subscription.findById(subscription._id)).status).toBe('trialing');
});

test.each([
  { identity: {}, observed: { status: 'trialing' } },
  { identity: { _id: 'synthetic' }, observed: { status: 'trialing' } },
  { identity: { _id: { $ne: null }, business: 'synthetic' }, observed: { status: 'trialing' } },
  { identity: { _id: 'synthetic', business: 'synthetic' }, observed: {} },
  { identity: { _id: 'synthetic', business: 'synthetic' }, observed: { status: { $ne: 'active' } } },
])('invalid completion contracts fail before any query: %j', async input => {
  await expect(conditionalWrite({ model: Subscription, ...input,
    update: { $set: { status: 'expired' } } })).rejects.toMatchObject({ code: 'INVALID_CONDITIONAL_WRITE' });
});

test('completion cannot reassign its business or upsert a deleted record', async () => {
  const { business, subscription } = await fixture();
  const input = { model: Subscription, identity: { _id: subscription._id, business: business._id },
    observed: { status: 'trialing' } };
  await expect(conditionalWrite({ ...input, update: { $set: { business: new mongoose.Types.ObjectId() } } }))
    .rejects.toMatchObject({ code: 'INVALID_CONDITIONAL_WRITE' });
  await Subscription.deleteOne({ _id: subscription._id });
  expect(await conditionalWrite({ ...input, update: { $set: { status: 'expired' } } }))
    .toEqual({ applied: false, current: null });
  expect(await Subscription.countDocuments()).toBe(0);
});

test('worker expiry rejects a stale paid snapshot without scheduling release metadata', async () => {
  const { subscription } = await fixture();
  await Subscription.updateOne({ _id: subscription._id }, { $set: { status: 'active', isActive: true } });
  const result = await expireObservedTrial(subscription, { releaseAt: new Date(),
    lastPaymentStatus: 'trial_expired_reconcile_pending' });
  expect(result.applied).toBe(false);
  expect(result.current.status).toBe('active');
  expect(result.current.trialNumberReleaseAt).toBeNull();
});
