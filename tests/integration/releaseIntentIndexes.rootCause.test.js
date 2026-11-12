import mongoose from 'mongoose';
import Intent from '../../src/models/trackingNumberReleaseIntent.js';
import manifest from '../../config/required-indexes.json';
import {inspectRequiredIndex} from '../../src/services/requiredIndexes.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
beforeAll(async()=>{await connectTestDB();await Intent.init()},60000);
afterEach(clearTestDB);afterAll(closeTestDB);
const intent=overrides=>({_id:new mongoose.Types.ObjectId().toHexString(),schemaVersion:1,business:new mongoose.Types.ObjectId(),
 provider:'twilio',providerAccountSid:'AC_SYNTHETIC',providerSid:'PN_SYNTHETIC',observedRevision:1,claimRevision:1,
 authorization:{kind:'administrative'},status:'pending',claimGeneration:0,...overrides});
test('the required-index gate contains every release-intent index with its safety options',async()=>{
 const actual=await Intent.collection.indexes();
 const entries=manifest.filter(row=>row.collection==='trackingnumberreleaseintents');expect(entries).toHaveLength(3);
 for(const entry of entries)expect(inspectRequiredIndex(actual,entry)).toBe('ok');
 expect(actual.some(index=>index.expireAfterSeconds!==undefined)).toBe(false);
});
test('two businesses cannot simultaneously release the same account SID',async()=>{
 const first=await Intent.create(intent());
 await expect(Intent.create(intent())).rejects.toMatchObject({code:11000});
 // Completed history never prevents an independent later operation.
 await Intent.updateOne({_id:first._id},{$set:{status:'completed'}});
 await expect(Intent.create(intent())).resolves.toBeDefined();
});
