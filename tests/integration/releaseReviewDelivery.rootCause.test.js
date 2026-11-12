import mongoose from 'mongoose';
import Alert from '../../src/models/alert.js';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import AlertService from '../../src/services/alert.service.js';
import {RELEASE_REVIEW_NEEDED,recordReleaseReview,reconcileReleaseReviews} from '../../src/services/trackingNumberReleaseReview.service.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';

let uri,bufferTimeout;
beforeAll(async()=>{uri=await connectTestDB();bufferTimeout=mongoose.get('bufferTimeoutMS');mongoose.set('bufferTimeoutMS',50);await Alert.init();},60000);
afterEach(async()=>{jest.restoreAllMocks();if(mongoose.connection.readyState!==1)await mongoose.connect(uri);await clearTestDB();});
afterAll(async()=>{mongoose.set('bufferTimeoutMS',bufferTimeout);await closeTestDB();});
async function pendingReview(){
 const {business}=await trackingFixture();
 return Intent.create({_id:'synthetic-review',schemaVersion:1,business:business._id,provider:'twilio',providerAccountSid:'AC_SYNTHETIC',
  providerSid:'PN_REVIEW',observedRevision:1,claimRevision:1,claimGeneration:1,claimToken:'review',authorization:{kind:'administrative'},
  status:'completed',providerOutcome:'removed',lastErrorCode:RELEASE_REVIEW_NEEDED});
}
test('reconciliation records one tenant-scoped recovery alert and acknowledges the obligation',async()=>{
 const intent=await pendingReview();
 expect(await reconcileReleaseReviews()).toEqual({examined:1,recorded:1});
 expect(await Alert.countDocuments({business:intent.business,dedupeKey:`number-release-review:${intent._id}`})).toBe(1);
 expect((await Intent.findById(intent._id)).lastErrorCode).toBe('RELEASE_RECOVERY_REVIEW_RECORDED');
 expect(await reconcileReleaseReviews()).toEqual({examined:0,recorded:0});
});
test('a database outage before alert delivery retains the retryable review obligation',async()=>{
 const intent=await pendingReview();await mongoose.disconnect();
 expect(await recordReleaseReview(intent)).toBe(false);
 await mongoose.connect(uri);
 expect((await Intent.findById(intent._id)).lastErrorCode).toBe(RELEASE_REVIEW_NEEDED);
 expect(await Alert.countDocuments()).toBe(0);
 expect(await reconcileReleaseReviews()).toEqual({examined:1,recorded:1});
});
test('a database outage after alert persistence retries without duplicating the delivered alert',async()=>{
 const intent=await pendingReview(),deliver=AlertService.createSystemAlert.bind(AlertService);
 jest.spyOn(AlertService,'createSystemAlert').mockImplementation(async payload=>{const result=await deliver(payload);await mongoose.disconnect();return result;});
 expect(await recordReleaseReview(intent)).toBe(false);
 jest.restoreAllMocks();await mongoose.connect(uri);
 expect(await Alert.countDocuments()).toBe(1);
 expect((await Intent.findById(intent._id)).lastErrorCode).toBe(RELEASE_REVIEW_NEEDED);
 expect(await reconcileReleaseReviews()).toEqual({examined:1,recorded:1});
 expect(await Alert.countDocuments()).toBe(1);
});
