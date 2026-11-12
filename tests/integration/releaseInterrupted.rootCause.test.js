import {fork} from 'node:child_process';
import path from 'node:path';
import Business from '../../src/models/business.js';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import OperationLease from '../../src/models/operationLease.js';
import {reconcileTrackingNumberReleases} from '../../src/services/trackingNumberProvisioning.service.js';
import {createTwilioClient} from '../../src/integrations/providerClients.js';
import {trackingFixture,configureTrackingFixture,providerFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
jest.mock('../../src/integrations/providerClients.js',()=>({...jest.requireActual('../../src/integrations/providerClients.js'),createTwilioClient:jest.fn()}));
let uri,child;
beforeAll(async()=>{uri=await connectTestDB();await Promise.all([Intent.init(),OperationLease.init()])},60000);
afterEach(async()=>{if(child && child.exitCode===null && !child.signalCode)child.kill('SIGKILL');jest.clearAllMocks();await clearTestDB()});
afterAll(closeTestDB);
test('another process reconciles a killed dispatcher using exact SID lookup and never redispatches deletion',async()=>{
 configureTrackingFixture();const {business}=await trackingFixture({trackingNumber:{providerSid:'PN123',status:'active'}});
 child=fork(path.resolve('tests/fixtures/releaseInterrupted.mjs'),[],{silent:true,env:{...process.env,
  SYNTHETIC_RELEASE_MONGO_URI:uri,SYNTHETIC_RELEASE_BUSINESS_ID:String(business._id)}});
 let diagnostic='';child.stderr.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-5000)});
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Synthetic dispatch did not reach its provider boundary: '+diagnostic))},3000);
  child.once('message',event=>{clearTimeout(timeout);if(event.event==='provider_accepted_without_receipt')resolve();else reject(new Error('Unexpected synthetic child event'))});
  child.once('error',error=>{clearTimeout(timeout);reject(error)});
  child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Dispatcher exited before acceptance (${code}): ${diagnostic}`))});
 });
 expect((await Intent.findOne({business:business._id})).status).toBe('dispatching');
 await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL')});
 // Advance durable claim expiry instead of waiting two minutes in a regression test.
 await OperationLease.updateOne({_id:`tracking-number:${business._id}`},{$set:{expiresAt:new Date(Date.now()-1)}});
 await Intent.updateOne({business:business._id},{$set:{claimExpiresAt:new Date(Date.now()-1)}});
 const provider=providerFixture();provider.fetch.mockRejectedValue({status:404,code:20404});createTwilioClient.mockReturnValue(provider.client);
 expect(await reconcileTrackingNumberReleases()).toMatchObject({examined:1,completed:1,uncertain:0,failed:0});
 expect(provider.incomingPhoneNumbers).toHaveBeenCalledWith('PN123');expect(provider.fetch).toHaveBeenCalledTimes(1);expect(provider.remove).not.toHaveBeenCalled();
 expect((await Intent.findOne({business:business._id})).status).toBe('completed');expect((await Business.findById(business._id)).phone).toBeUndefined();
});
