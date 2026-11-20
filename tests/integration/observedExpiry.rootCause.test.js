import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import "../../src/models/trialRedemption.js";
import { expireTrialIfNeeded } from "../../src/services/trialExpiry.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);

async function expiredTrial() {
  const business = await Business.create({ owner: new mongoose.Types.ObjectId(),
    businessName: 'Synthetic expiry regression', businessType: 'plumbing', email: 'expiry@example.test' });
  return Subscription.create({ business: business._id, status: 'trialing', isActive: true,
    aiEnabled: true, trialEndsAt: new Date(Date.now() - 60000),
    stripeCustomerId: 'cus_expiry_regression', stripeSubscriptionId: 'sub_expiry_regression' });
}

test('an expired read cannot overwrite a paid conversion and returns the current subscription', async () => {
  const trial = await expiredTrial();
  const observed = await Subscription.findById(trial._id);
  await Subscription.updateOne({ _id: trial._id }, { $set: { status: 'active', isActive: true, aiEnabled: true } });
  const result = await expireTrialIfNeeded(observed);
  expect(result).toMatchObject({ status: 'active', isActive: true, aiEnabled: true });
  expect(await Subscription.findById(trial._id)).toMatchObject({ status: 'active', isActive: true, aiEnabled: true });
});

test('an expired read cannot overwrite a concurrently extended end date', async () => {
  const trial = await expiredTrial();
  const observed = await Subscription.findById(trial._id);
  const extendedEnd = new Date(Date.now() + 86400000);
  await Subscription.updateOne({ _id: trial._id }, { $set: { trialEndsAt: extendedEnd } });
  const result = await expireTrialIfNeeded(observed);
  expect(result.status).toBe('trialing');
  expect(result.trialEndsAt.getTime()).toBe(extendedEnd.getTime());
  expect((await Subscription.findById(trial._id)).status).toBe('trialing');
});

test('an unchanged expired trial retains the existing entitlement transition', async () => {
  const trial = await expiredTrial();
  const result = await expireTrialIfNeeded(trial);
  expect(result).toMatchObject({ status: 'expired', lastPaymentStatus: 'trial_expired', isActive: false, aiEnabled: false });
});
