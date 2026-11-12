import BillingController from '../../src/controllers/billing.js';
import Subscription from '../../src/models/subscription.js';
import '../../src/models/user.js';
import Grant from '../../src/models/trialExtensionGrant.js';
import {syncStripeSubscription} from '../../src/services/trialLifecycle.service.js';
import {extendTrial} from '../../src/services/trialExtension.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
jest.mock('../../src/services/trackingNumberProvisioning.service.js',()=>({provisionTrackingNumber:jest.fn()}));
beforeAll(connectTestDB,60000);afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
test.each(['conversion','extension'])('a delayed Stripe refresh cannot overwrite a newer %s',async change=>{
 const {business,subscription}=await trackingFixture(),later=new Date(Date.now()+7*86400000);
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'trialing',trialEndsAt:new Date(Date.now()-1000),trialUsedAt:new Date()}});
 const remote={id:'sub_tracking',customer:'cus_tracking',status:'paused',metadata:{businessId:String(business._id)},items:{data:[]}};
 getStripeClient.mockReturnValue({subscriptions:{retrieve:jest.fn(async()=>{
  await Subscription.updateOne({_id:subscription._id},{$set:change==='conversion'?{status:'active',isActive:true,trialNumberReleaseAt:null}:{trialEndsAt:later}});
  return remote;
 })}});
 const result=await syncStripeSubscription({stripeSubscription:remote});
 expect(result.status).toBe(change==='conversion'?'active':'trialing');
 const current=await Subscription.findById(subscription._id);expect(current.status).toBe(result.status);
 if(change==='extension')expect(current.trialEndsAt).toEqual(later);
});
test('an extension receipt for an old canonical SID cannot modify the replacement subscription',async()=>{
 const {business,subscription}=await trackingFixture(),end=new Date(Date.now()+86400000),replacementEnd=new Date(Date.now()+20*86400000);
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'trialing',trialUsedAt:new Date(),trialEndsAt:end}});
 getStripeClient.mockReturnValue({subscriptions:{update:jest.fn(async(_id,body)=>{
  await Subscription.updateOne({_id:subscription._id},{$set:{stripeSubscriptionId:'sub_replacement',trialEndsAt:replacementEnd,currentPeriodEnd:replacementEnd}});
  return {status:'trialing',trial_end:body.trial_end};
 })}});
 await expect(extendTrial({businessId:business._id,adminUserId:business.owner,days:7,reason:'Synthetic incident',operationKey:'old-canonical'})).rejects.toMatchObject({code:'TRIAL_EXTENSION_PENDING'});
 const current=await Subscription.findById(subscription._id);expect(current.stripeSubscriptionId).toBe('sub_replacement');expect(current.currentPeriodEnd).toEqual(replacementEnd);expect(await Grant.countDocuments()).toBe(0);
});

test.each(['handleInvoicePaid','handleInvoicePaymentFailed'])('%s cannot project an invoice over a conversion completed during provider refresh',async method=>{
 const {business,subscription}=await trackingFixture();
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'paused',isActive:false,latestInvoiceId:'in_old'}});
 const remote={id:'sub_tracking',customer:'cus_tracking',status:'paused',metadata:{businessId:String(business._id)},
  latest_invoice:{id:'in_old',status:'open'},items:{data:[]}};
 getStripeClient.mockReturnValue({subscriptions:{retrieve:jest.fn(async()=>{
  await Subscription.updateOne({_id:subscription._id},{$set:{status:'active',isActive:true,latestInvoiceId:'in_new',lastPaymentStatus:'paid'}});
  return remote;
 })}});
 await BillingController[method]({id:'in_old',subscription:'sub_tracking',customer:'cus_tracking'});
 expect(await Subscription.findById(subscription._id)).toMatchObject({status:'active',isActive:true,latestInvoiceId:'in_new',lastPaymentStatus:'paid'});
});

test('a cancellation receipt cannot schedule cancellation on a replacement canonical subscription',async()=>{
 const {business,subscription}=await trackingFixture();
 getStripeClient.mockReturnValue({subscriptions:{update:jest.fn(async()=>{
  await Subscription.updateOne({_id:subscription._id},{$set:{stripeSubscriptionId:'sub_new',cancelAtPeriodEnd:false}});
  return {status:'active',cancel_at_period_end:true};
 })}});
 const response={status:jest.fn().mockReturnThis(),json:jest.fn().mockReturnThis()};
 await BillingController.cancelSubscription({user:{userId:String(business.owner)},business,subscription:await Subscription.findById(subscription._id)},response);
 expect(response.status).toHaveBeenCalledWith(409);
 expect(await Subscription.findById(subscription._id)).toMatchObject({stripeSubscriptionId:'sub_new',cancelAtPeriodEnd:false});
});

test.each(['legacy','modern','expanded'].flatMap(shape=>['paid','failed'].map(outcome=>[shape,outcome])))('persists the canonical %s invoice contract for %s',async(shape,outcome)=>{
 const {business,subscription}=await trackingFixture();
 const remote={id:'sub_tracking',customer:'cus_tracking',status:outcome==='paid'?'active':'past_due',metadata:{businessId:String(business._id)},items:{data:[]}};
 const retrieve=jest.fn().mockResolvedValue(remote);getStripeClient.mockReturnValue({subscriptions:{retrieve}});
 const invoice={id:'in_contract',customer:'cus_tracking',...(shape==='legacy'?{subscription:'sub_tracking'}:
  {parent:{subscription_details:{subscription:shape==='expanded'?{id:'sub_tracking'}:'sub_tracking'}}})};
 const result=await BillingController[outcome==='paid'?'handleInvoicePaid':'handleInvoicePaymentFailed'](invoice,'evt_contract');
 expect(retrieve).toHaveBeenCalledWith('sub_tracking',{expand:['latest_invoice']});
 expect(result.lastPaymentStatus).toBe(outcome);
 expect(await Subscription.findById(subscription._id)).toMatchObject({latestInvoiceId:'in_contract',lastPaymentStatus:outcome,status:remote.status});
});
test('cancellation targets the exact canonical SID and persists returned billing period state',async()=>{
 const {business,subscription}=await trackingFixture(),update=jest.fn().mockResolvedValue({status:'active',current_period_end:1900000000});
 getStripeClient.mockReturnValue({subscriptions:{update}});
 const response={status:jest.fn().mockReturnThis(),json:jest.fn().mockReturnThis()};
 await BillingController.cancelSubscription({user:{userId:String(business.owner)},business,subscription:await Subscription.findById(subscription._id)},response);
 expect(update).toHaveBeenCalledWith('sub_tracking',{cancel_at_period_end:true});expect(response.status).toHaveBeenCalledWith(200);
 expect(await Subscription.findById(subscription._id)).toMatchObject({cancelAtPeriodEnd:true,status:'active',currentPeriodEnd:new Date(1900000000*1000)});
});
