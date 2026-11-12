import Alert from '../../src/models/alert.js';
import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import { processTrialLifecycle } from '../../src/services/trialLifecycle.service.js';
import { getStripeClient, resetStripeClient } from '../../src/helpers/stripe/stripeClient.js';
import { createTwilioClient } from '../../src/integrations/providerClients.js';
import { sendTrialExpiredEmail, sendTrackingNumberReleasedEmail } from '../../src/helpers/email/mailer.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';

jest.mock('../../src/integrations/providerClients.js', () => ({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
jest.mock('../../src/helpers/email/mailer.js', () => ({ sendTrialExpiredEmail: jest.fn(),
  sendTrialWelcomeEmail: jest.fn(), sendTrialReminderEmail: jest.fn(), sendTrackingNumberReleasedEmail: jest.fn() }));
beforeAll(connectTestDB, 60000);
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  process.env.TRIAL_NO_PAYMENT_METHOD_NUMBER_RELEASE_GRACE_HOURS = '48';
  resetStripeClient();
  sendTrialExpiredEmail.mockResolvedValue({ messageId: 'synthetic-expiry-receipt' });
});
afterEach(async () => { jest.restoreAllMocks(); jest.clearAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);

async function fixture(now) {
  const business = await Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Synthetic worker',
    businessType: 'plumbing', email: 'worker@example.test',
    setupProgress: { subscriptionActivated: true }, trialCostControls: { enabled: true } });
  const subscription = await Subscription.create({ business: business._id, status: 'trialing', isActive: true,
    aiEnabled: true, trialUsedAt: new Date(now.getTime() - 86400000), trialEndsAt: new Date(now.getTime() - 1000),
    stripeCustomerId: 'cus_expiry_worker', stripeSubscriptionId: 'sub_expiry_worker' });
  return { business, subscription };
}

test('fails safe on expired-trial Stripe reconciliation and schedules the short paused-trial release grace', async () => {
  const now = new Date();
  const { business, subscription } = await fixture(now);
  jest.spyOn(getStripeClient().subscriptions, 'retrieve').mockRejectedValue(new Error('Synthetic Stripe outage'));
  expect(await processTrialLifecycle(now)).toEqual({ processed: 1 });
  const stored = await Subscription.findById(subscription._id);
  expect(stored).toMatchObject({ status: 'expired', isActive: false, aiEnabled: false,
    lastPaymentStatus: 'trial_expired_reconcile_pending' });
  expect(stored.trialNumberReleaseAt.getTime()).toBe(now.getTime() + 48 * 3600000);
  const ownerState = await Business.findById(business._id);
  expect(ownerState.setupProgress.subscriptionActivated).toBe(false);
  expect(ownerState.trialCostControls.enabled).toBe(false);
  expect(sendTrialExpiredEmail).toHaveBeenCalledWith(expect.objectContaining({ email: 'worker@example.test' }));
});

test('a concurrent conversion prevents stale expiry effects and retains paid access', async () => {
  const now = new Date();
  const { subscription } = await fixture(now);
  jest.spyOn(getStripeClient().subscriptions, 'retrieve').mockImplementation(async () => {
    await Subscription.updateOne({ _id: subscription._id }, { $set: { status: 'active', isActive: true, aiEnabled: true } });
    throw new Error('Synthetic lost reconciliation response');
  });
  expect(await processTrialLifecycle(now)).toEqual({ processed: 1 });
  expect(await Subscription.findById(subscription._id)).toMatchObject({ status: 'active', isActive: true, aiEnabled: true,
    trialNumberReleaseAt: null });
  expect(sendTrialExpiredEmail).not.toHaveBeenCalled();
});

test('failed Stripe release reconciliation cannot reschedule a concurrently paid subscription',async()=>{
 const now=new Date(),{subscription}=await fixture(now);
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'paused',trialNumberReleaseAt:new Date(now.getTime()-1000)}});
 jest.spyOn(getStripeClient().subscriptions,'retrieve').mockImplementation(async()=>{
  await Subscription.updateOne({_id:subscription._id},{$set:{status:'active',trialNumberReleaseAt:null,isActive:true,aiEnabled:true}});
  throw new Error('Synthetic lost paid response');
 });
 await processTrialLifecycle(now);
 expect(await Subscription.findById(subscription._id)).toMatchObject({status:'active',trialNumberReleaseAt:null});
 expect(sendTrackingNumberReleasedEmail).not.toHaveBeenCalled();
});
test('a release completion cannot clear a newer subscription release schedule or send its notice',async()=>{
 const now=new Date(),{business,subscription}=await fixture(now),later=new Date(now.getTime()+86400000);
 Object.assign(process.env,{TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000',TWILIO_AUTH_TOKEN:'test-auth-token'});
 await Business.updateOne({_id:business._id},{$set:{phone:'+14045550123','trackingNumber.providerSid':'PN_OLD','trackingNumber.status':'active'}});
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'expired',stripeSubscriptionId:'',trialNumberReleaseAt:new Date(now.getTime()-1000)}});
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove:async()=>{
  await Subscription.updateOne({_id:subscription._id},{$set:{status:'active',stripeSubscriptionId:'sub_new',trialNumberReleaseAt:later}});
  return true;
 }})});
 await processTrialLifecycle(now);
 const row=await Subscription.findById(subscription._id);
 expect(row.status).toBe('active');expect(row.trialNumberReleaseAt).toEqual(later);
 expect(sendTrackingNumberReleasedEmail).not.toHaveBeenCalled();
 const review=await Alert.findOne({business:business._id,'metadata.code':'ENTITLEMENT_CHANGED_DURING_NUMBER_RELEASE'});
 expect(review).not.toBeNull();expect(review.actionRequired).toBe(true);
});
