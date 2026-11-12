import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import TrialRedemption from '../../src/models/trialRedemption.js';
import '../../src/models/user.js';
import {syncStripeSubscription} from '../../src/services/trialLifecycle.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';

jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
jest.mock('../../src/services/trackingNumberProvisioning.service.js',()=>({provisionTrackingNumber:jest.fn()}));
const originalMode=process.env.NODE_ENV;
beforeAll(connectTestDB,60000);
afterEach(async()=>{process.env.NODE_ENV=originalMode; jest.clearAllMocks();await clearTestDB();});
afterAll(closeTestDB);

test.each(['test','development','staging','production'])('standalone Mongo cannot partially redeem a trial in %s',async mode=>{
 const {business,subscription}=await trackingFixture();
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'incomplete',isActive:false,aiEnabled:false}});
 const started=Math.floor(Date.now()/1000);
 const remote={id:'sub_tracking',customer:'cus_tracking',status:'trialing',trial_start:started,trial_end:started+14*86400,
  metadata:{businessId:String(business._id),ownerId:String(business.owner)},items:{data:[]}};
 getStripeClient.mockReturnValue({subscriptions:{retrieve:jest.fn().mockResolvedValue(remote)}});
 process.env.NODE_ENV=mode;
 await expect(syncStripeSubscription({stripeSubscription:remote})).rejects.toMatchObject({code:'TRIAL_TRANSACTION_REQUIRED',statusCode:503});
 expect(await TrialRedemption.countDocuments()).toBe(0);
 expect(await Subscription.findById(subscription._id)).toMatchObject({status:'incomplete',isActive:false,aiEnabled:false});
 expect((await Business.findById(business._id)).setupProgress.subscriptionActivated).toBe(false);
});
