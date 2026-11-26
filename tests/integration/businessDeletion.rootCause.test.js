import TrackingNumber from '../../src/models/trackingNumber.js';
import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import {createTwilioClient} from '../../src/integrations/providerClients.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {deleteBusinessSafely} from '../../src/services/businessDeletion.service.js';
import {assignTrackingNumber} from '../../src/services/trackingNumberProvisioning.service.js';
import {trackingFixture,configureTrackingFixture,providerFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/integrations/providerClients.js',()=>({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
beforeAll(connectTestDB,60000);beforeEach(()=>{configureTrackingFixture();getStripeClient.mockReturnValue({subscriptions:{cancel:jest.fn().mockResolvedValue({status:'canceled'})}})});
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
const assigned={trackingNumber:{providerSid:'PN123',status:'active'}};
test('deletion refuses an uncertain release and preserves business, subscription and intent for recovery',async()=>{
 const {business}=await trackingFixture(assigned),state=providerFixture();createTwilioClient.mockReturnValue(state.client);state.remove.mockRejectedValue({status:503});
 await expect(deleteBusinessSafely({businessId:business._id})).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
 expect(await Business.findById(business._id)).not.toBeNull();expect(await Subscription.findOne({business:business._id})).not.toBeNull();
 expect((await Intent.findOne({business:business._id})).status).toBe('uncertain');
 expect(getStripeClient().subscriptions.cancel).not.toHaveBeenCalled();
});
test('deletion cannot erase a replacement number that wins during provider completion',async()=>{
 const {business}=await trackingFixture(assigned),state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 state.remove.mockImplementation(async()=>{await Business.updateOne({_id:business._id},{$set:{phone:'+14045550124','trackingNumber.providerSid':'PN_NEW'}});return true});
 await expect(deleteBusinessSafely({businessId:business._id})).rejects.toMatchObject({code:'BUSINESS_DELETION_RELEASE_CHANGED'});
 const row=await Business.findById(business._id).select('+trackingNumber.providerSid');
 expect(row.phone).toBe('+14045550124');expect(row.trackingNumber.providerSid).toBe('PN_NEW');
 expect(await Subscription.findOne({business:business._id})).not.toBeNull();
});
test('confirmed cleanup retains its durable intent after deleting the business and prevents competing provisioning',async()=>{
 const {business}=await trackingFixture(assigned),state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 state.remove.mockImplementation(async()=>{
  // Provider execution runs inside the business operation; deleting accounts cannot start provision work.
  await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'BUSINESS_DELETION_IN_PROGRESS'});
  expect((await Intent.findOne({business:business._id})).status).toBe('dispatching');return true;
 });
 await deleteBusinessSafely({businessId:business._id});
 expect(await Business.findById(business._id)).toBeNull();expect(await Subscription.findOne({business:business._id})).toBeNull();
 const retained=await Intent.findOne({status:'completed'}).select('+providerSid +providerAccountSid');
 expect(retained.status).toBe('completed');expect(String(retained.business)).not.toBe(String(business._id));expect(retained.providerSid).toMatch(/^erased:/);expect(retained.providerAccountSid).toMatch(/^erased:/);
});

test('deleting an unallocated account without a subscription never calls billing',async()=>{
 const {business,subscription}=await trackingFixture({phone:undefined});
 await Subscription.deleteOne({_id:subscription._id});
 await deleteBusinessSafely({businessId:business._id});
 expect(await Business.findById(business._id)).toBeNull();expect(getStripeClient().subscriptions.cancel).not.toHaveBeenCalled();
});
test.each(['subscription','business'])('a changed %s observation aborts both local deletes',async resource=>{
 const {business,subscription}=await trackingFixture({phone:undefined});
 getStripeClient().subscriptions.cancel.mockImplementation(async()=>{
  if(resource==='subscription')await Subscription.updateOne({_id:subscription._id},{$inc:{__v:1}});
  else await Business.updateOne({_id:business._id},{$inc:{'trackingNumber.revision':1}});
  return {status:'canceled'};
 });
 await expect(deleteBusinessSafely({businessId:business._id})).rejects.toMatchObject({code:resource==='subscription'?'BUSINESS_DELETION_SUBSCRIPTION_CHANGED':'BUSINESS_DELETION_RELEASE_CHANGED'});
 expect(await Business.findById(business._id)).not.toBeNull();expect(await Subscription.findById(subscription._id)).not.toBeNull();
});
test('a provider failure without structured fields retains a stable retryable cleanup receipt',async()=>{
 const {business}=await trackingFixture({phone:undefined});
 getStripeClient().subscriptions.cancel.mockRejectedValue({});
 await expect(deleteBusinessSafely({businessId:business._id})).rejects.toMatchObject({code:'BUSINESS_DELETION_CLEANUP_FAILED',statusCode:503});
 const retained=await Business.findById(business._id);
 expect(retained.accountLifecycle.lastError).toBe('BUSINESS_DELETION_CLEANUP_FAILED: Cleanup failed');
 expect(await Subscription.findOne({business:business._id})).not.toBeNull();
});

test('H04 deletion verifies release of a secondary billable tracking number before erasing it',async()=>{
 const {business}=await trackingFixture({phone:undefined});const state=providerFixture();state.incoming.sid='PN_EXTRA';createTwilioClient.mockReturnValue(state.client);
 await TrackingNumber.create({business:business._id,kind:'marketing',phoneNumber:'+14045550129',phoneLookup:'+14045550129',providerSid:'PN_EXTRA',status:'active'});
 await deleteBusinessSafely({businessId:business._id});expect(state.remove).toHaveBeenCalledTimes(1);expect(await Business.findById(business._id)).toBeNull();expect(await TrackingNumber.countDocuments({business:business._id})).toBe(0);
});
test('H04 ambiguous secondary number ownership fails closed without releasing the other tenant resource',async()=>{
 const {business}=await trackingFixture({phone:undefined});const state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 await TrackingNumber.create({business:business._id,kind:'marketing',phoneNumber:'+14045550129',phoneLookup:'+14045550129',providerSid:'PN_SHARED',status:'active'});
 await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Another synthetic tenant',forwardingPhone:'+14045550888',phone:'+14045550889',trackingNumber:{providerSid:'PN_SHARED',status:'active'}});
 await expect(deleteBusinessSafely({businessId:business._id})).rejects.toMatchObject({code:'BUSINESS_DELETION_NUMBER_OWNERSHIP_CONFLICT'});expect(state.remove).not.toHaveBeenCalled();expect(await Business.findById(business._id)).not.toBeNull();
});
