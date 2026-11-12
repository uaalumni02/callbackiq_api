import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import OperationLease from '../../src/models/operationLease.js';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import {createTwilioClient} from '../../src/integrations/providerClients.js';
import {activateTrackingNumber,assignTrackingNumber,releaseTrackingNumber,verifyTrackingNumber} from '../../src/services/trackingNumberProvisioning.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
import {configureTrackingFixture,trackingFixture,providerFixture,expectedWebhooks} from '../fixtures/trackingNumber.fixture.js';
jest.mock('../../src/integrations/providerClients.js',()=>({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
jest.mock('../../src/services/trialTelecomGuard.service.js',()=>({assertAutomaticProvisioningBudget:jest.fn(),provisioningBudgetEnabled:()=>false}));
jest.mock('../../src/services/a2pMessagingRegistration.service.js',()=>({attachPhoneNumberToBusinessMessagingRegistration:jest.fn().mockResolvedValue({a2pStatus:'unconfigured'}),toMessagingComplianceUpdate:()=>({})}));
beforeAll(connectTestDB,60000);
beforeEach(configureTrackingFixture);
afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});
afterAll(closeTestDB);
const active={phone:'+14045550123',trackingNumber:{status:'active',providerSid:'PN123'}};
test('unknown businesses fail before touching provider',async()=>{
 await expect(assignTrackingNumber(new mongoose.Types.ObjectId())).rejects.toMatchObject({code:'BUSINESS_NOT_FOUND'});expect(createTwilioClient).not.toHaveBeenCalled();
});
test('requires a Stripe backed active or trialing subscription',async()=>{
 const {business}=await trackingFixture({phone:''});await Subscription.deleteMany({});
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'SUBSCRIPTION_REQUIRED'});expect(createTwilioClient).not.toHaveBeenCalled();
});
test('requires a forwarding phone before purchase',async()=>{
 const {business}=await trackingFixture({phone:'',forwardingPhone:''});
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'FORWARDING_PHONE_REQUIRED'});expect(createTwilioClient).not.toHaveBeenCalled();
});
test('already active assignment is idempotent and leaves no held claim',async()=>{
 const {business}=await trackingFixture(active);expect((await assignTrackingNumber(business._id)).phone).toBe(business.phone);
 expect(createTwilioClient).not.toHaveBeenCalled();expect(await OperationLease.countDocuments()).toBe(0);
});
test('no available number records failure and releases claim',async()=>{
 const {business}=await trackingFixture({phone:''}),state=providerFixture();state.availableList.mockResolvedValue([]);createTwilioClient.mockReturnValue(state.client);
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'NO_TRACKING_NUMBER_AVAILABLE'});
 expect(state.availableList).toHaveBeenCalledWith(expect.objectContaining({areaCode:404,smsEnabled:true,voiceEnabled:true}));
 expect((await Business.findById(business._id)).trackingNumber.lastError).toContain('NO_TRACKING_NUMBER_AVAILABLE');expect(await OperationLease.countDocuments()).toBe(0);
});
test('non HTTPS webhook configuration blocks purchase and releases claim',async()=>{
 const {business}=await trackingFixture({phone:''}),state=providerFixture();createTwilioClient.mockReturnValue(state.client);process.env.TWILIO_WEBHOOK_BASE_URL='http://api.callbackiq.test';
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'TWILIO_WEBHOOK_BASE_URL_REQUIRED'});
 expect(state.create).not.toHaveBeenCalled();expect(await OperationLease.countDocuments()).toBe(0);
});
test('a persistence conflict preserves replacement and durably cleans up known orphan SID',async()=>{
 const {business}=await trackingFixture({phone:''}),state=providerFixture();createTwilioClient.mockReturnValue(state.client);
 state.create.mockImplementation(async()=>{await Business.updateOne({_id:business._id},{$set:{phone:'+14045550124','trackingNumber.providerSid':'PN_REPLACEMENT','trackingNumber.status':'active'}});return state.incoming});
 state.remove.mockImplementation(async()=>{expect(await Intent.findOne({business:business._id}).select('+providerSid')).toMatchObject({status:'dispatching',providerSid:'PN123',resourceRole:'unattached'});return true});
 await expect(assignTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_CHANGED'});
 expect(state.incomingPhoneNumbers).toHaveBeenCalledWith('PN123');expect(state.remove).toHaveBeenCalledTimes(1);
 expect((await Intent.findOne({business:business._id})).status).toBe('completed');
 expect((await Business.findById(business._id)).phone).toBe('+14045550124');expect(await OperationLease.countDocuments()).toBe(0);
});
test('verify rejects provider phone mismatch and records failure',async()=>{
 const {business}=await trackingFixture({...active,trackingNumber:{status:'assigned',providerSid:'PN123'}}),state=providerFixture();
 state.fetch.mockResolvedValue({...state.incoming,phoneNumber:'+14045550000'});createTwilioClient.mockReturnValue(state.client);
 await expect(verifyTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_PROVIDER_MISMATCH'});
 expect((await Business.findById(business._id)).trackingNumber.lastError).toContain('TRACKING_NUMBER_PROVIDER_MISMATCH');
});
test('verify repairs provider webhooks before persisting verified state',async()=>{
 const {business}=await trackingFixture({...active,trackingNumber:{status:'assigned',providerSid:'PN123'}}),state=providerFixture();
 state.fetch.mockResolvedValue({...state.incoming,voiceUrl:'https://old.example/voice'});createTwilioClient.mockReturnValue(state.client);
 const result=await verifyTrackingNumber(business._id);expect(result.trackingNumber.status).toBe('verified');
 expect(state.update).toHaveBeenCalledWith(expect.objectContaining({...expectedWebhooks,voiceMethod:'POST',smsMethod:'POST',statusCallbackMethod:'POST'}));
 expect((await Business.findById(business._id)).trackingNumber.verifiedAt).toBeInstanceOf(Date);
});
test('release converges when provider already reports exact SID missing',async()=>{
 const {business}=await trackingFixture(active),state=providerFixture();state.remove.mockRejectedValue({status:404});createTwilioClient.mockReturnValue(state.client);
 expect((await releaseTrackingNumber(business._id)).phone).toBeUndefined();expect(state.remove).toHaveBeenCalled();
 expect((await Intent.findOne({business:business._id})).status).toBe('completed');
});
test('non 404 provider failure is recorded as uncertain and retains local number',async()=>{
 const {business}=await trackingFixture(active),state=providerFixture();state.remove.mockRejectedValue({status:503});createTwilioClient.mockReturnValue(state.client);
 await expect(releaseTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN',statusCode:503});
 expect(await Intent.findOne({business:business._id})).toMatchObject({status:'uncertain',providerOutcome:'unknown',lastErrorCode:expect.any(String)});
 expect((await Business.findById(business._id)).phone).toBe(business.phone);
});
test('active activation is idempotent without provider invocation or lifecycle timestamp change',async()=>{
 const {business}=await trackingFixture(active),before=await Business.findById(business._id);const result=await activateTrackingNumber(business._id);
 expect(result.phone).toBe(before.phone);expect(result.trackingNumber.status).toBe('active');expect(result.trackingNumber.activatedAt).toEqual(before.trackingNumber.activatedAt);
 expect(createTwilioClient).not.toHaveBeenCalled();
});
