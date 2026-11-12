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
 expect((await Intent.findOne({business:business._id})).status).toBe('completed');
});
