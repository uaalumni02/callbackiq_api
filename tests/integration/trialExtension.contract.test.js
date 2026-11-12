import Subscription from '../../src/models/subscription.js';
import Grant from '../../src/models/trialExtensionGrant.js';
import {extendTrial} from '../../src/services/trialExtension.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
let update;
beforeAll(connectTestDB,60000);beforeEach(()=>{process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS='14';update=jest.fn(async(_id,body)=>({status:'trialing',trial_end:body.trial_end}));getStripeClient.mockReturnValue({subscriptions:{update}})});
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
const input=({business},extra={})=>({businessId:business._id,adminUserId:business.owner,days:2,reason:'Support recovery',operationKey:'synthetic-contract',...extra});
async function trial(){const pair=await trackingFixture();await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'trialing',trialUsedAt:new Date(),trialEndsAt:new Date(Date.now()+86400000)}});return pair}
test('requires an auditable reason for admin trial extensions',async()=>{
 const pair=await trial();await expect(extendTrial(input(pair,{reason:'   '}))).rejects.toMatchObject({code:'TRIAL_EXTENSION_REASON_REQUIRED'});
 expect(update).not.toHaveBeenCalled();expect(await Grant.countDocuments()).toBe(0);
});
test('rejects extension attempts without a live Stripe trial',async()=>{
 const pair=await trackingFixture();await expect(extendTrial(input(pair))).rejects.toMatchObject({code:'ACTIVE_TRIAL_REQUIRED'});
 expect(update).not.toHaveBeenCalled();expect(await Grant.countDocuments()).toBe(0);
});
test('enforces the lifetime admin extension allowance',async()=>{
 const pair=await trial(),end=new Date(Date.now()+86400000);
 for(const [i,days]of [10,3].entries())await Grant.create({business:pair.business._id,subscription:pair.subscription._id,grantedBy:pair.business.owner,
  days,reason:'Prior grant',previousTrialEndsAt:end,newTrialEndsAt:end,operationKey:'prior-'+i});
 await expect(extendTrial(input(pair))).rejects.toMatchObject({code:'TRIAL_EXTENSION_LIMIT_REACHED'});expect(update).not.toHaveBeenCalled();expect(await Grant.countDocuments()).toBe(2);
});
test('clamps an admin extension to 14 days and records the audit grant',async()=>{
 const pair=await trial(),before=await Subscription.findById(pair.subscription._id);
 const result=await extendTrial(input(pair,{days:99,reason:'  Service recovery  '}));
 expect(result.trialEndsAt.getTime()).toBe(Math.floor((before.trialEndsAt.getTime()+14*86400000)/1000)*1000);
 expect(update).toHaveBeenCalledWith('sub_tracking',expect.objectContaining({trial_end:expect.any(Number),proration_behavior:'none'}),expect.objectContaining({idempotencyKey:expect.any(String)}));
 const grant=await Grant.findOne({business:pair.business._id}).lean();expect(grant).toMatchObject({days:14,reason:'Service recovery'});
 expect(String(grant.grantedBy)).toBe(String(pair.business.owner));expect(String(grant.subscription)).toBe(String(pair.subscription._id));
 expect((await Subscription.findById(pair.subscription._id)).trialExtensionIntent.status).toBe('applied');
});

test('a newer projection cannot strand a verified extension receipt in pending state',async()=>{
 const pair=await trial(),write=Grant.findOneAndUpdate.bind(Grant);
 const spy=jest.spyOn(Grant,'findOneAndUpdate').mockImplementation((...args)=>{
  const query=write(...args),exec=query.exec.bind(query);
  query.exec=async()=>{const grant=await exec();await Subscription.updateOne({_id:pair.subscription._id},{$inc:{__v:1}});return grant};
  return query;
 });
 try {
  await extendTrial(input(pair));
  expect((await Subscription.findById(pair.subscription._id)).trialExtensionIntent.status).toBe('applied');
  expect(await Grant.countDocuments()).toBe(1);expect(update).toHaveBeenCalledTimes(1);
 } finally {spy.mockRestore()}
});
