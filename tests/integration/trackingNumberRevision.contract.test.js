import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import { withTrackingNumberOperation } from '../../src/services/trackingNumberState.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
beforeAll(connectTestDB,60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
const fixture = () => Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Revision contract',
  businessType:'plumbing',email:'revision@example.test',trackingNumber:{providerSid:'PN_PRIVATE'}});
test('persisted revision starts at zero, provider SID stays private, and embedded state has no identity',async()=>{
  const row = await fixture(), read = await Business.findById(row._id).lean();
  expect(read.trackingNumber.revision).toBe(0);
  expect(read.trackingNumber.providerSid).toBeUndefined();
  expect(read.trackingNumber._id).toBeUndefined();
});
test.each([-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid revision %s',async revision=>{
  const row = await fixture(); row.trackingNumber.revision=revision;
  await expect(row.save()).rejects.toThrow();
});
test('a legacy missing revision acquires a fence without a backfill migration',async()=>{
  const row = await fixture();
  await Business.collection.updateOne({_id:row._id},{$unset:{'trackingNumber.revision':1}});
  const current = await withTrackingNumberOperation(row._id,'test',async business=>business);
  expect(current.trackingNumber.revision).toBe(1);
  expect((await Business.findById(row._id)).trackingNumber.revision).toBe(1);
});

test('a legacy business with no embedded tracking state can acquire its first revision without a migration',async()=>{
 const row=await fixture();
 await Business.collection.updateOne({_id:row._id},{$unset:{trackingNumber:1}});
 const outcome=await withTrackingNumberOperation(row._id,'test',async business=>business)
  .then(current=>({revision:current.trackingNumber.revision}),error=>({error:error.code}));
 expect(outcome).toEqual({revision:1});expect((await Business.findById(row._id)).trackingNumber.revision).toBe(1);
});
