import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import OperationLease from '../../src/models/operationLease.js';
import {planUnattachedNumberRelease} from '../../src/services/trackingNumberRelease.service.js';
import { releaseTrackingNumberWithReceipt, reconcileTrackingNumberReleases } from '../../src/services/trackingNumberProvisioning.service.js';
import { createTwilioClient } from '../../src/integrations/providerClients.js';
import { releaseTrackingNumber } from '../../src/services/trackingNumberProvisioning.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

jest.mock('../../src/integrations/providerClients.js', () => ({
  ...jest.requireActual('../../src/integrations/providerClients.js'), createTwilioClient: jest.fn(),
}));
beforeAll(connectTestDB, 60000);
afterEach(async () => { jest.clearAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);

test('old provider completion cannot erase the replacement SID and phone', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  const business = await Business.create({ owner: new mongoose.Types.ObjectId(),
    businessName: 'Synthetic release regression', businessType: 'plumbing', email: 'release@example.test',
    phone: '+14045550121', trackingNumber: { status: 'active', providerSid: 'PN_OLD' } });
  let entered, resume;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  const providerResume = new Promise(resolve => { resume = resolve; });
  createTwilioClient.mockReturnValue({ incomingPhoneNumbers: () => ({ remove: async () => {
    entered(); await providerResume; return true;
  } }) });
  const oldRelease = releaseTrackingNumber(business._id);
  await providerEntered;
  await Business.updateOne({ _id: business._id }, { $set: { phone: '+14045550122',
    'trackingNumber.providerSid': 'PN_NEW', 'trackingNumber.status': 'active' } });
  resume();
  await oldRelease;
  const current = await Business.findById(business._id).select('+trackingNumber.providerSid');
  expect(current.phone).toBe('+14045550122');
  expect(current.trackingNumber.providerSid).toBe('PN_NEW');
  expect(current.trackingNumber.status).toBe('active');
});

async function releaseFixture() {
  process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  return Business.create({ owner: new mongoose.Types.ObjectId(), businessName: 'Synthetic release receipt',
    businessType: 'plumbing', email: 'receipt@example.test', phone: '+14045550123',
    trackingNumber: { status: 'active', providerSid: 'PN_RECEIPT' } });
}
const readIntent = business => Intent.findOne({ business: business._id }).select('+providerSid +claimToken');

test('persists the exact SID and revision dispatch intent before provider removal', async () => {
  const business = await releaseFixture();
  const remove = jest.fn(async () => {
    const intent = await readIntent(business);
    expect(intent).toMatchObject({ status: 'dispatching', providerSid: 'PN_RECEIPT', schemaVersion: 1 });
    expect(intent.observedRevision).toBeGreaterThan(0);
    expect(intent.claimRevision).toBe(intent.observedRevision);
    return true;
  });
  createTwilioClient.mockReturnValue({ incomingPhoneNumbers: () => ({ remove }) });
  expect(await releaseTrackingNumberWithReceipt(business._id)).toMatchObject({ outcome: 'released' });
  expect(remove).toHaveBeenCalledTimes(1);
  expect((await readIntent(business)).status).toBe('completed');
  expect((await Business.findById(business._id)).phone).toBeUndefined();
});

test('an uncertain deletion never redispatches while exact SID lookup still finds the number', async () => {
  const business = await releaseFixture();
  const remove = jest.fn().mockRejectedValue(Object.assign(new Error('Synthetic timeout'), {code: 'ETIMEDOUT'}));
  const fetch = jest.fn().mockResolvedValue({sid:'PN_RECEIPT'});
  createTwilioClient.mockReturnValue({ incomingPhoneNumbers: () => ({ remove, fetch }) });
  await expect(releaseTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
  await expect(releaseTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
  expect(remove).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await readIntent(business)).status).toBe('uncertain');
  expect((await Business.findById(business._id)).phone).toBe('+14045550123');
});

test('reconciles a lost receipt using exact SID absence, without deleting twice', async () => {
  const business = await releaseFixture();
  const remove = jest.fn().mockRejectedValue(Object.assign(new Error('Synthetic timeout'), {code:'ETIMEDOUT'}));
  const fetch = jest.fn().mockRejectedValue({status:404,code:20404});
  const incomingPhoneNumbers = jest.fn(() => ({remove,fetch}));
  createTwilioClient.mockReturnValue({incomingPhoneNumbers});
  await expect(releaseTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
  expect(await reconcileTrackingNumberReleases({limit:1})).toMatchObject({examined:0});
  // A crashed/uncertain dispatch is recovered only after its durable claim expires.
  await Intent.updateOne({business:business._id},{$set:{claimExpiresAt:new Date(Date.now()-1)}});
  const result = await reconcileTrackingNumberReleases({limit:1});
  expect(result).toMatchObject({examined:1,completed:1,uncertain:0,failed:0});
  expect(incomingPhoneNumbers.mock.calls.every(([sid])=>sid==='PN_RECEIPT')).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await readIntent(business)).status).toBe('completed');
  expect((await Business.findById(business._id)).phone).toBeUndefined();
});

test.each([false,true])('a lost lease cannot complete or adopt its successor intent claim: %s', async stealIntent => {
  const business = await releaseFixture();
  createTwilioClient.mockReturnValue({ incomingPhoneNumbers: () => ({remove:async () => {
    await OperationLease.updateOne({_id:`tracking-number:${business._id}`},{$set:{token:'successor-lease'}});
    if(stealIntent) await Intent.updateOne({business:business._id},{$set:{claimToken:'successor-intent',claimGeneration:99}});
    return true;
  }}) });
  await expect(releaseTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
  expect((await Business.findById(business._id)).phone).toBe('+14045550123');
  expect((await OperationLease.findById(`tracking-number:${business._id}`)).token).toBe('successor-lease');
  const intent = await readIntent(business);
  expect(intent.status).toBe(stealIntent?'dispatching':'uncertain');
  if(stealIntent) expect(intent).toMatchObject({claimToken:'successor-intent',claimGeneration:99});
});

test('a stale reconciliation target cannot dispatch a release against a replacement SID',async()=>{
 const business=await releaseFixture(),remove=jest.fn().mockResolvedValue(true);
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove})});
 await releaseTrackingNumber(business._id);
 await Business.updateOne({_id:business._id},{$set:{phone:'+14045550124','trackingNumber.providerSid':'PN_NEW','trackingNumber.status':'active'}});
 expect(await releaseTrackingNumberWithReceipt(business._id,{targetProviderSid:'PN_RECEIPT'})).toMatchObject({outcome:'superseded'});
 expect(remove).toHaveBeenCalledTimes(1);
 expect((await Business.findById(business._id)).phone).toBe('+14045550124');
});

test.each([false,undefined,null,{}])('an unverified provider return cannot clear a number: %p',async receipt=>{
 const business=await releaseFixture();
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove:async()=>receipt})});
 await expect(releaseTrackingNumber(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
 expect((await Business.findById(business._id)).phone).toBe('+14045550123');
 expect((await readIntent(business)).status).toBe('uncertain');
});

test('an account with no number needs neither a provider client nor a release intent',async()=>{
 const business=await releaseFixture();
 await Business.updateOne({_id:business._id},{$unset:{phone:1},$set:{'trackingNumber.providerSid':'','trackingNumber.status':'unassigned'}});
 expect(await releaseTrackingNumberWithReceipt(business._id)).toMatchObject({outcome:'already_released',intentId:null});
 expect(createTwilioClient).not.toHaveBeenCalled();expect(await Intent.countDocuments()).toBe(0);
});
test('a stored phone without provider identity is retained for reconciliation',async()=>{
 const business=await releaseFixture();await Business.updateOne({_id:business._id},{$set:{'trackingNumber.providerSid':''}});
 await expect(releaseTrackingNumberWithReceipt(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_STATE_INCONSISTENT'});
 expect((await Business.findById(business._id)).phone).toBe('+14045550123');expect(await Intent.countDocuments()).toBe(0);
});
test('an explicit provider rejection remains pending and does not clear the phone',async()=>{
 const business=await releaseFixture(),remove=jest.fn().mockRejectedValue({status:403,code:20003});
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove})});
 await expect(releaseTrackingNumberWithReceipt(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_REJECTED'});
 expect((await readIntent(business)).status).toBe('pending');expect((await Business.findById(business._id)).phone).toBe('+14045550123');
});

test('orphan cleanup planning is idempotent and never clears the assigned number',async()=>{
 const business=await releaseFixture(),input={business,providerSid:'PN_ORPHAN',accountSid:process.env.TWILIO_ACCOUNT_SID};
 const first=await planUnattachedNumberRelease(input),second=await planUnattachedNumberRelease(input);
 expect(second._id).toBe(first._id);expect(await Intent.countDocuments()).toBe(1);
 const remove=jest.fn().mockResolvedValue(true),numbers=jest.fn(()=>({remove}));
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:numbers});
 expect(await releaseTrackingNumberWithReceipt(business._id)).toMatchObject({outcome:'released_unattached'});
 expect(numbers).toHaveBeenCalledWith('PN_ORPHAN');expect(remove).toHaveBeenCalledTimes(1);
 expect((await Business.findById(business._id)).phone).toBe('+14045550123');
 expect((await Intent.findById(first._id)).status).toBe('completed');
});
test('an uncertain orphan release reconciles exact SID absence without dispatching twice',async()=>{
 const business=await releaseFixture();
 await planUnattachedNumberRelease({business,providerSid:'PN_ORPHAN',accountSid:process.env.TWILIO_ACCOUNT_SID});
 const remove=jest.fn().mockRejectedValue({code:'ETIMEDOUT'}),fetch=jest.fn().mockRejectedValue({status:404,code:20404});
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove,fetch})});
 await expect(releaseTrackingNumberWithReceipt(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
 expect(await releaseTrackingNumberWithReceipt(business._id)).toMatchObject({outcome:'released_unattached'});
 expect(remove).toHaveBeenCalledTimes(1);expect(fetch).toHaveBeenCalledTimes(1);
 expect((await Business.findById(business._id)).phone).toBe('+14045550123');
});
test('a number adopted by another tenant supersedes orphan cleanup without provider removal',async()=>{
 const business=await releaseFixture();
 await planUnattachedNumberRelease({business,providerSid:'PN_ADOPTED',accountSid:process.env.TWILIO_ACCOUNT_SID});
 await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Synthetic other tenant',businessType:'plumbing',email:'adopted@example.test',
  trackingNumber:{providerSid:'PN_ADOPTED',status:'active'},phone:'+14045550124'});
 const remove=jest.fn();createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove})});
 expect(await releaseTrackingNumberWithReceipt(business._id)).toMatchObject({outcome:'superseded'});
 expect(remove).not.toHaveBeenCalled();expect((await readIntent(business)).lastErrorCode).toBe('RELEASE_AUTHORIZATION_CHANGED');
});
test('an intent for a different provider account cannot be dispatched',async()=>{
 const business=await releaseFixture();await planUnattachedNumberRelease({business,providerSid:'PN_ORPHAN',accountSid:'AC_DIFFERENT'});
 const remove=jest.fn();createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove})});
 await expect(releaseTrackingNumberWithReceipt(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
 expect(remove).not.toHaveBeenCalled();expect((await readIntent(business)).status).toBe('pending');
});
test('an expiry release without an observed subscription is superseded before provider dispatch',async()=>{
 const business=await releaseFixture(),remove=jest.fn();createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove})});
 expect(await releaseTrackingNumberWithReceipt(business._id,{authorization:{kind:'trial_expiry'}})).toMatchObject({outcome:'superseded'});
 expect(remove).not.toHaveBeenCalled();expect((await Business.findById(business._id)).phone).toBe('+14045550123');
});
test('the worker reports uncertain reconciliation separately from a missing business',async()=>{
 const business=await releaseFixture(),remove=jest.fn().mockRejectedValue({code:'ETIMEDOUT'}),fetch=jest.fn().mockResolvedValue({sid:'PN_RECEIPT'});
 createTwilioClient.mockReturnValue({incomingPhoneNumbers:()=>({remove,fetch})});
 await expect(releaseTrackingNumberWithReceipt(business._id)).rejects.toMatchObject({code:'TRACKING_NUMBER_RELEASE_UNCERTAIN'});
 await Intent.updateOne({business:business._id},{$set:{claimExpiresAt:new Date(0)}});
 expect(await reconcileTrackingNumberReleases()).toMatchObject({examined:1,uncertain:1,failed:0});
 await Intent.updateOne({business:business._id},{$set:{claimExpiresAt:new Date(0)}});await Business.deleteOne({_id:business._id});
 expect(await reconcileTrackingNumberReleases()).toMatchObject({examined:1,uncertain:0,failed:1});
 expect(remove).toHaveBeenCalledTimes(1);
});
