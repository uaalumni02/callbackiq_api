import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import TrialRedemption from '../../src/models/trialRedemption.js';
import '../../src/models/user.js';
import {syncStripeSubscription} from '../../src/services/trialLifecycle.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
jest.mock('../../src/services/trackingNumberProvisioning.service.js',()=>({provisionTrackingNumber:jest.fn()}));
beforeAll(connectTestDB,60000);afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
async function duplicateTrial(){
 const {business,subscription}=await trackingFixture();
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'incomplete',isActive:false,aiEnabled:false}});
 const redemption=await TrialRedemption.create({business:new mongoose.Types.ObjectId(),owner:business.owner,
  emailKey:'original-trial@example.test',stripeSubscriptionId:'sub_original'});
 const start=Math.floor(Date.now()/1000),remote={id:'sub_tracking',customer:'cus_tracking',status:'trialing',trial_start:start,
  trial_end:start+14*86400,metadata:{businessId:String(business._id),ownerId:String(business.owner)},items:{data:[]}};
 return {business,subscription,redemption,remote};
}
test.each([false,true])('duplicate identity is denied durably even when provider cancellation fails (%s)',async cancellationFails=>{
 const {business,subscription,redemption,remote}=await duplicateTrial();
 const cancel=jest.fn(async()=>{if(cancellationFails)throw new Error('Synthetic provider outage');return {id:remote.id,status:'canceled'}});
 getStripeClient.mockReturnValue({subscriptions:{retrieve:jest.fn().mockResolvedValue(remote),cancel}});
 const result=await syncStripeSubscription({stripeSubscription:remote});
 expect(cancel).toHaveBeenCalledWith('sub_tracking');expect(result.status).toBe('canceled');
 expect(await Subscription.findById(subscription._id)).toMatchObject({status:'canceled',isActive:false,aiEnabled:false,lastPaymentStatus:'trial_identity_rejected'});
 expect(await TrialRedemption.countDocuments()).toBe(1);expect((await TrialRedemption.findById(redemption._id)).stripeSubscriptionId).toBe('sub_original');
 expect((await Business.findById(business._id)).setupProgress.subscriptionActivated).toBe(false);
});
test('a late duplicate-trial denial cannot overwrite a paid canonical replacement',async()=>{
 const {business,subscription,remote}=await duplicateTrial();
 const cancel=jest.fn(async()=>{
  await Subscription.updateOne({_id:subscription._id},{$set:{status:'active',stripeSubscriptionId:'sub_paid',isActive:true,aiEnabled:true,
   lastPaymentStatus:'paid',latestInvoiceId:'in_paid'},$inc:{__v:1}});
  return {id:'sub_tracking',status:'canceled'};
 });
 getStripeClient.mockReturnValue({subscriptions:{retrieve:jest.fn().mockResolvedValue(remote),cancel}});
 const result=await syncStripeSubscription({stripeSubscription:remote});
 expect(cancel).toHaveBeenCalledTimes(1);expect(result.status).toBe('active');expect(result.stripeSubscriptionId).toBe('sub_paid');expect(result.lastPaymentStatus).toBe('paid');
 expect(await Subscription.findById(subscription._id)).toMatchObject({status:'active',stripeSubscriptionId:'sub_paid',latestInvoiceId:'in_paid',aiEnabled:true});
 expect((await Business.findById(business._id)).setupProgress.subscriptionActivated).toBe(true);
});
