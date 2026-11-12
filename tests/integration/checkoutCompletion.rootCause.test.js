import Subscription from '../../src/models/subscription.js';
import {createSubscriptionCheckout} from '../../src/services/trialLifecycle.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn(),getPriceIdByPlan:()=> 'price_pro'}));
jest.mock('../../src/helpers/billing/trial.js',()=>({...jest.requireActual('../../src/helpers/billing/trial.js'),getTrialEligibility:async()=>({eligible:true})}));
let stripe;
beforeAll(connectTestDB,60000);beforeEach(()=>{
 Object.assign(process.env,{TRIAL_MAX_NEW_TRIALS_PER_DAY:'10',TRIAL_MAX_CONCURRENT_ACTIVE:'25',TRIAL_MAX_TRACKING_NUMBERS_HELD:'40'});
 stripe={customers:{search:jest.fn().mockResolvedValue({data:[]}),create:jest.fn().mockResolvedValue({id:'cus_new'})},
  subscriptions:{list:jest.fn().mockResolvedValue({data:[]})},checkout:{sessions:{create:jest.fn().mockResolvedValue({id:'cs_test',url:'https://checkout.example.test/session'})}}};
 getStripeClient.mockReturnValue(stripe);
});
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
async function fixture(){const pair=await trackingFixture();await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'paused',isActive:false,stripeCustomerId:''}});return pair}
const input=({business},extra={})=>({business,ownerId:business.owner,plan:'pro',requireTrial:false,...extra});
test('reuses an existing provider customer without creating a duplicate',async()=>{
 const pair=await fixture();stripe.customers.search.mockResolvedValue({data:[{id:'cus_existing',metadata:{businessId:String(pair.business._id)}}]});
 const result=await createSubscriptionCheckout(input(pair));expect(stripe.customers.create).not.toHaveBeenCalled();
 expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({customer:'cus_existing',mode:'subscription'}),expect.any(Object));
 expect(result).toMatchObject({checkoutSessionId:'cs_test',trialOffered:false});expect((await Subscription.findById(pair.subscription._id)).stripeCustomerId).toBe('cus_existing');
});
test('no card trial checkout retains stable idempotency, pause policy and persisted session',async()=>{
 const pair=await fixture();await createSubscriptionCheckout(input(pair,{requireTrial:true}));
 expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({name:pair.business.businessName,email:pair.business.email}),
  expect.objectContaining({idempotencyKey:`callbackiq:customer:${pair.business._id}`}));
 expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({mode:'subscription',payment_method_collection:'if_required',
  subscription_data:expect.objectContaining({trial_period_days:14,trial_settings:{end_behavior:{missing_payment_method:'pause'}}})}),
  expect.objectContaining({idempotencyKey:expect.stringContaining(`callbackiq:checkout:${pair.business._id}`)}));
 expect((await Subscription.findById(pair.subscription._id)).checkoutSessionId).toBe('cs_test');
});
test('an older checkout completion cannot demote a concurrent paid conversion',async()=>{
 const pair=await fixture();stripe.checkout.sessions.create.mockImplementation(async()=>{
  await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'active',isActive:true,aiEnabled:true,checkoutSessionId:'cs_paid'}});
  return {id:'cs_old',url:'https://checkout.example.test/old'};
 });
 await expect(createSubscriptionCheckout(input(pair))).rejects.toMatchObject({code:'CHECKOUT_STATE_CHANGED',current:expect.objectContaining({status:'active'})});
 expect(await Subscription.findById(pair.subscription._id)).toMatchObject({status:'active',isActive:true,aiEnabled:true,checkoutSessionId:'cs_paid'});
});
