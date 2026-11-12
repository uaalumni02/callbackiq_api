import Subscription from '../../src/models/subscription.js';
import {completeTrialPaymentMethodCheckout} from '../../src/services/subscriptionActions.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
let stripe;
beforeAll(connectTestDB,60000);beforeEach(()=>{
 const remote={id:'sub_tracking',status:'trialing'};
 stripe={subscriptions:{retrieve:jest.fn().mockResolvedValue(remote),list:jest.fn().mockResolvedValue({data:[remote]}),
  update:jest.fn().mockResolvedValue(remote),resume:jest.fn()},customers:{update:jest.fn().mockResolvedValue({})},
  setupIntents:{retrieve:jest.fn().mockResolvedValue({payment_method:'pm_tracking'})}};getStripeClient.mockReturnValue(stripe);
});
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
async function fixture(){const pair=await trackingFixture();await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'trialing',trialEndsAt:new Date(Date.now()+86400000)}});
 return {...pair,checkoutSession:{id:'cs_setup',mode:'setup',setup_intent:'seti_tracking',metadata:{purpose:'trial_payment_method',businessId:String(pair.business._id),stripeSubscriptionId:'sub_tracking'}}}}
test('retrieves a string setup intent, sets both provider defaults, and persists the verified marker',async()=>{
 const pair=await fixture();const result=await completeTrialPaymentMethodCheckout(pair);
 expect(stripe.setupIntents.retrieve).toHaveBeenCalledWith('seti_tracking',{expand:['payment_method']});
 expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_tracking',{default_payment_method:'pm_tracking'},{idempotencyKey:'callbackiq:trial-default-payment-method:cs_setup'});
 expect(stripe.customers.update).toHaveBeenCalledWith('cus_tracking',{invoice_settings:{default_payment_method:'pm_tracking'}},{idempotencyKey:'callbackiq:customer-default-payment-method:cs_setup'});
 expect(result.lastPaymentStatus).toBe('trial_payment_method_added');expect((await Subscription.findById(pair.subscription._id)).lastPaymentStatus).toBe('trial_payment_method_added');
});
test('does not require the optional customer update API to complete a trial',async()=>{
 const pair=await fixture();stripe.customers={};expect(await completeTrialPaymentMethodCheckout(pair)).toBeTruthy();
 expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);expect((await Subscription.findById(pair.subscription._id)).lastPaymentStatus).toBe('trial_payment_method_added');
});
test('adding a payment method while the free trial is active never resumes it',async()=>{
 const pair=await fixture();pair.checkoutSession.setup_intent={payment_method:{id:'pm_inline'}};
 expect((await completeTrialPaymentMethodCheckout(pair)).lastPaymentStatus).toBe('trial_payment_method_added');
 expect(stripe.subscriptions.resume).not.toHaveBeenCalled();expect((await Subscription.findById(pair.subscription._id)).status).toBe('trialing');
});
test('a late setup completion cannot overwrite a newer paid invoice marker',async()=>{
 const pair=await fixture();stripe.subscriptions.update.mockImplementation(async()=>{
  await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'active',lastPaymentStatus:'paid',latestInvoiceId:'in_new'}});return {id:'sub_tracking',status:'trialing'};
 });
 const result=await completeTrialPaymentMethodCheckout(pair);expect(result.lastPaymentStatus).toBe('paid');
 expect(await Subscription.findById(pair.subscription._id)).toMatchObject({status:'active',lastPaymentStatus:'paid',latestInvoiceId:'in_new'});
});
