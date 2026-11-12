import Business from '../../src/models/business.js';
import OperationLease from '../../src/models/operationLease.js';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import {assignTrackingNumber} from '../../src/services/trackingNumberProvisioning.service.js';
import {createTwilioClient} from '../../src/integrations/providerClients.js';
import {trackingFixture,configureTrackingFixture,providerFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
jest.mock('../../src/integrations/providerClients.js',()=>({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
beforeAll(connectTestDB,60000);beforeEach(()=>{configureTrackingFixture();process.env.TRACKING_NUMBER_PROVISIONING_WAIT_MS='1'});
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
test('a held business claim blocks purchase, and a successful unmanaged assignment persists fail closed A2P',async()=>{
 const {business}=await trackingFixture({phone:''}),state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 await OperationLease.create({_id:`tracking-number:${business._id}`,token:'another-worker',expiresAt:new Date(Date.now()+60000)});
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_PROVISIONING_IN_PROGRESS'});
 expect(state.create).not.toHaveBeenCalled();
 await OperationLease.deleteOne({_id:`tracking-number:${business._id}`});
 await assignTrackingNumber(business._id);
 const current=await Business.findById(business._id).select('+trackingNumber.providerSid');
 expect(current.trackingNumber.providerSid).toBe('PN123');expect(current.messagingCompliance).toMatchObject({a2pStatus:'pending',smsReady:false});
 expect(await OperationLease.countDocuments()).toBe(0);
});
test('a known orphan is released only after its intent is durable and the replacement survives',async()=>{
 const {business}=await trackingFixture({phone:''}),state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 state.create.mockImplementation(async()=>{await Business.updateOne({_id:business._id},{$set:{phone:'+14045550124','trackingNumber.providerSid':'PN_NEW','trackingNumber.status':'active'}});return state.incoming});
 state.remove.mockImplementation(async()=>{expect(await Intent.findOne({business:business._id}).select('+providerSid')).toMatchObject({status:'dispatching',providerSid:'PN123',resourceRole:'unattached'});return true});
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_CHANGED'});
 expect(state.remove).toHaveBeenCalledTimes(1);expect(state.incomingPhoneNumbers).toHaveBeenCalledWith('PN123');
 expect((await Business.findById(business._id)).phone).toBe('+14045550124');expect((await Intent.findOne({business:business._id})).status).toBe('completed');
});
