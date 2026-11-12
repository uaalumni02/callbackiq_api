import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {provisionTrackingNumber,releaseTrackingNumberWithReceipt} from '../../src/services/trackingNumberProvisioning.service.js';
import {sendTrialReminderEmail,sendTrackingNumberReleasedEmail} from '../../src/helpers/email/mailer.js';
import {processTrialLifecycle} from '../../src/services/trialLifecycle.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn(),getPriceIdByPlan:jest.fn()}));
jest.mock('../../src/services/trackingNumberProvisioning.service.js',()=>({...jest.requireActual('../../src/services/trackingNumberProvisioning.service.js'),provisionTrackingNumber:jest.fn(),releaseTrackingNumberWithReceipt:jest.fn()}));
jest.mock('../../src/helpers/email/mailer.js',()=>({sendTrialReminderEmail:jest.fn(),sendTrialWelcomeEmail:jest.fn(),sendTrialExpiredEmail:jest.fn(),sendTrackingNumberReleasedEmail:jest.fn()}));
const DAY=86400000;
beforeAll(connectTestDB,60000);
beforeEach(()=>{
 jest.clearAllMocks();provisionTrackingNumber.mockResolvedValue(null);
 releaseTrackingNumberWithReceipt.mockImplementation(async business=>({outcome:'released',intentId:'synthetic-receipt',business}));
 sendTrialReminderEmail.mockResolvedValue({messageId:'synthetic-reminder'});sendTrackingNumberReleasedEmail.mockResolvedValue({messageId:'synthetic-released'});
 getStripeClient.mockReturnValue({subscriptions:{retrieve:jest.fn().mockRejectedValue(new Error('Synthetic outage'))}});
});
afterEach(clearTestDB);afterAll(closeTestDB);
async function trial(now,changes={}) {
 const pair=await trackingFixture();
 await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'trialing',trialEndsAt:new Date(now.getTime()+DAY),
  trialUsedAt:new Date(now.getTime()-DAY),...changes}});
 return pair;
}
test('processes an empty lifecycle batch',async()=>expect(await processTrialLifecycle()).toEqual({processed:0}));
test('repairs telecom readiness for full access trials and persists the one day notice',async()=>{
 const now=new Date(),{business,subscription}=await trial(now,{trialEndsAt:new Date(now.getTime()+12*3600000)});
 await Business.updateOne({_id:business._id},{$unset:{phone:1}});
 expect(await processTrialLifecycle(now)).toEqual({processed:1});
 expect(String(provisionTrackingNumber.mock.calls[0][0])).toBe(String(business._id));
 expect(sendTrialReminderEmail).toHaveBeenCalledWith(expect.objectContaining({email:'tracking@example.test',daysRemaining:1}));
 expect((await Subscription.findById(subscription._id)).trialReminder1dSentAt).toBeInstanceOf(Date);
});
test('sends the three day reminder without reprovisioning an active number',async()=>{
 const now=new Date(),{business}=await trial(now,{trialEndsAt:new Date(now.getTime()+2*DAY)});
 await Business.updateOne({_id:business._id},{$set:{'trackingNumber.status':'active'}});
 await processTrialLifecycle(now);expect(provisionTrackingNumber).not.toHaveBeenCalled();
 expect(sendTrialReminderEmail).toHaveBeenCalledWith(expect.objectContaining({daysRemaining:3}));
});
test('postpones release when final Stripe reconciliation is unavailable',async()=>{
 const now=new Date(),{subscription}=await trial(now,{status:'expired',trialEndsAt:new Date(now.getTime()-DAY),trialNumberReleaseAt:new Date(now.getTime()-1000)});
 await processTrialLifecycle(now);
 expect((await Subscription.findById(subscription._id)).trialNumberReleaseAt).toEqual(new Date(now.getTime()+DAY));
 expect(releaseTrackingNumberWithReceipt).not.toHaveBeenCalled();
});
test('a due release without a remote subscription persists its receipt notice',async()=>{
 const now=new Date(),{business,subscription}=await trial(now,{status:'expired',stripeSubscriptionId:'',trialEndsAt:new Date(now.getTime()-DAY),trialNumberReleaseAt:new Date(now.getTime()-1000)});
 expect(await processTrialLifecycle(now)).toEqual({processed:1});
 expect(String(releaseTrackingNumberWithReceipt.mock.calls[0][0])).toBe(String(business._id));
 const row=await Subscription.findById(subscription._id);expect(row.trialNumberReleaseAt).toBeNull();expect(row.trialNumberReleasedNotifiedAt).toBeInstanceOf(Date);
 expect(sendTrackingNumberReleasedEmail).toHaveBeenCalledWith(expect.objectContaining({email:'tracking@example.test',businessName:'Synthetic tracking contract'}));
});
test('carrier release failure preserves its due schedule and sends no released notice',async()=>{
 const now=new Date(),due=new Date(now.getTime()-1000),{subscription}=await trial(now,{status:'expired',stripeSubscriptionId:'',trialEndsAt:new Date(now.getTime()-DAY),trialNumberReleaseAt:due});
 releaseTrackingNumberWithReceipt.mockRejectedValue(new Error('Synthetic carrier failure'));
 await processTrialLifecycle(now);expect((await Subscription.findById(subscription._id)).trialNumberReleaseAt).toEqual(due);expect(sendTrackingNumberReleasedEmail).not.toHaveBeenCalled();
});
