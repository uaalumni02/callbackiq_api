import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import {createTwilioClient} from '../../src/integrations/providerClients.js';
import {activateTrackingNumber,verifyTrackingNumber} from '../../src/services/trackingNumberProvisioning.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
import {configureTrackingFixture,trackingFixture,providerFixture} from '../fixtures/trackingNumber.fixture.js';
jest.mock('../../src/integrations/providerClients.js',()=>({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
beforeAll(connectTestDB,60000);
beforeEach(configureTrackingFixture);
afterEach(async()=>{jest.restoreAllMocks();jest.clearAllMocks();await clearTestDB()});
afterAll(closeTestDB);
test('late verification cannot downgrade a replacement active number',async()=>{
 const {business}=await trackingFixture({trackingNumber:{providerSid:'PN123',status:'assigned'}}),state=providerFixture();
 createTwilioClient.mockReturnValue(state.client);
 state.fetch.mockImplementation(async()=>{await Business.updateOne({_id:business._id},{$set:{phone:'+14045550124','trackingNumber.providerSid':'PN_NEW','trackingNumber.status':'active'}});return state.incoming});
 await expect(verifyTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_CHANGED'});
 const row=await Business.findById(business._id).select('+trackingNumber.providerSid');
 expect(row.trackingNumber.status).toBe('active');expect(row.trackingNumber.providerSid).toBe('PN_NEW');expect(row.phone).toBe('+14045550124');
});
test('late activation cannot activate a newly assigned replacement',async()=>{
 const {business}=await trackingFixture({trackingNumber:{providerSid:'PN123',status:'verified'}});
 const find=Subscription.findOne.bind(Subscription);
 jest.spyOn(Subscription,'findOne').mockImplementation((...args)=>{
  const query=find(...args),lean=query.lean.bind(query);
  query.lean=async()=>{const observed=await lean();await Business.updateOne({_id:business._id},{$set:{'trackingNumber.providerSid':'PN_NEW','trackingNumber.status':'assigned'}});return observed};
  return query;
 });
 await expect(activateTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_CHANGED'});
 const row=await Business.findById(business._id).select('+trackingNumber.providerSid');
 expect(row.trackingNumber.providerSid).toBe('PN_NEW');expect(row.trackingNumber.status).toBe('assigned');
});
