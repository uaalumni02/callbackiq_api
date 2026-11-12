import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import OperationLease from '../../src/models/operationLease.js';
import {createTwilioClient} from '../../src/integrations/providerClients.js';
import {assignTrackingNumber,isTrackingNumberStateInconsistent,reconcileExistingTrackingNumber} from '../../src/services/trackingNumberProvisioning.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
import {configureTrackingFixture,trackingFixture,providerFixture,expectedWebhooks} from '../fixtures/trackingNumber.fixture.js';
const mockSecurityGateEnabled=jest.fn(()=>false);
jest.mock('../../src/integrations/providerClients.js',()=>({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
jest.mock('../../src/services/trialTelecomGuard.service.js',()=>({assertAutomaticProvisioningBudget:jest.fn(),provisioningBudgetEnabled:()=>false}));
jest.mock('../../src/services/trialIdentityVerification.service.js',()=>({securityGateEnabled:(...args)=>mockSecurityGateEnabled(...args)}));
beforeAll(connectTestDB,60000);
beforeEach(()=>{configureTrackingFixture();mockSecurityGateEnabled.mockReturnValue(false)});
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});
afterAll(closeTestDB);
test.each([
 [null,false],[{phone:'',trackingNumber:{status:'unassigned',providerSid:''}},false],
 [{phone:'+14045550123',trackingNumber:{status:'unassigned',providerSid:''}},true],
 [{phone:'+14045550123',trackingNumber:{status:'active',providerSid:''}},true],
 [{phone:'+14045550123',trackingNumber:{status:'verified',providerSid:'PN123'}},false],
])('detects inconsistent persisted provider state %#',(business,expected)=>expect(isTrackingNumberStateInconsistent(business)).toBe(expected));
test('rejects invalid persisted phone without touching provider inventory',async()=>{
 const {business}=await trackingFixture(),state=providerFixture();
 await Business.collection.updateOne({_id:business._id},{$set:{phone:'invalid'}});
 await expect(reconcileExistingTrackingNumber({business,client:state.client})).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_INCONSISTENT',statusCode:409});
 expect(state.list).not.toHaveBeenCalled();
});
test('fails closed when stored phone cannot be found in configured account',async()=>{
 const {business}=await trackingFixture(),state=providerFixture();state.list.mockResolvedValue([]);
 await expect(reconcileExistingTrackingNumber({business,client:state.client})).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_INCONSISTENT'});
 expect(state.list).toHaveBeenCalledWith({phoneNumber:'+14045550123',limit:20});expect(state.create).not.toHaveBeenCalled();
});
test('falls back to account inventory when filtered lookup is unavailable',async()=>{
 const {business}=await trackingFixture(),state=providerFixture();
 state.list.mockRejectedValueOnce(new Error('Unsupported filter')).mockResolvedValueOnce([{...state.incoming,phoneNumber:'+14045550000'},state.incoming]);
 expect((await reconcileExistingTrackingNumber({business,client:state.client})).trackingNumber.status).toBe('active');
 expect(state.list).toHaveBeenNthCalledWith(1,{phoneNumber:'+14045550123',limit:20});expect(state.list).toHaveBeenNthCalledWith(2,{limit:1000});
});
test('repairs stale webhooks before persisting active state and setup flags',async()=>{
 const {business}=await trackingFixture(),state=providerFixture();state.list.mockResolvedValue([{...state.incoming,voiceUrl:'https://old.example/voice'}]);
 await reconcileExistingTrackingNumber({business,client:state.client});
 expect(state.incomingPhoneNumbers).toHaveBeenCalledWith('PN123');
 expect(state.update).toHaveBeenCalledWith({...expectedWebhooks,voiceMethod:'POST',voiceFallbackMethod:'POST',smsMethod:'POST',smsFallbackMethod:'POST',statusCallbackMethod:'POST'});
 const row=await Business.findById(business._id).select('+trackingNumber.providerSid +phoneLookup').lean();
 expect(row).toMatchObject({phone:'+14045550123',phoneLookup:'+14045550123',trackingNumber:{provider:'twilio',providerSid:'PN123',status:'active'},
  setupProgress:{trackingNumberAssigned:true,trackingNumberVerified:true,trackingNumberActive:true}});
});
test('matching webhooks preserve lifecycle timestamps without provider rewrite',async()=>{
 const timestamps={assignedAt:new Date('2026-07-01'),verifiedAt:new Date('2026-07-02'),activatedAt:new Date('2026-07-03')};
 const {business}=await trackingFixture({trackingNumber:{status:'unassigned',providerSid:'',...timestamps}}),state=providerFixture();
 await reconcileExistingTrackingNumber({business,client:state.client});expect(state.update).not.toHaveBeenCalled();
 expect((await Business.findById(business._id)).trackingNumber).toMatchObject(timestamps);
});
test('provider creation time fills missing assignment time',async()=>{
 const {business}=await trackingFixture(),state=providerFixture();await reconcileExistingTrackingNumber({business,client:state.client});
 const row=await Business.findById(business._id);
 expect(row.trackingNumber.assignedAt).toEqual(state.incoming.dateCreated);expect(row.trackingNumber.verifiedAt).toBeInstanceOf(Date);expect(row.trackingNumber.activatedAt).toBeInstanceOf(Date);
});
test('assign reconciles existing phone without a duplicate purchase and releases its claim',async()=>{
 const {business}=await trackingFixture(),state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 expect((await assignTrackingNumber(business._id)).trackingNumber.status).toBe('active');
 expect(state.list).toHaveBeenCalled();expect(state.availableList).not.toHaveBeenCalled();expect(state.create).not.toHaveBeenCalled();
 expect(await OperationLease.countDocuments()).toBe(0);
});
test('trial purchase requires verification of the current forwarding phone',async()=>{
 const {business,subscription}=await trackingFixture({phone:'',forwardingPhoneVerifiedAt:new Date(),forwardingPhoneVerifiedValue:'+14045550000'});
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'trialing',trialEndsAt:new Date(Date.now()+86400000)}});mockSecurityGateEnabled.mockReturnValue(true);
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'TRIAL_PHONE_VERIFICATION_REQUIRED',statusCode:403});
 expect(createTwilioClient).not.toHaveBeenCalled();expect(await OperationLease.countDocuments()).toBe(0);
});
