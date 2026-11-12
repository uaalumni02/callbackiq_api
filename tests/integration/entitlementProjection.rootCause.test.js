import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import {projectCurrentEntitlement} from '../../src/services/subscriptionEntitlement.service.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
beforeAll(connectTestDB,60000);
afterEach(async()=>{jest.restoreAllMocks();await clearTestDB()});
afterAll(closeTestDB);
test('an old projection retries after a concurrent paid conversion and retains current entitlement',async()=>{
 const {business,subscription}=await trackingFixture();
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'expired',isActive:false}});
 const find=Subscription.findOne.bind(Subscription);let interleaved=false;
 jest.spyOn(Subscription,'findOne').mockImplementation((...args)=>{
  const query=find(...args),exec=query.exec.bind(query);
  query.exec=async function(){const observed=await exec();
   if(this.getOptions().session && !interleaved){interleaved=true;
    await Subscription.collection.updateOne({_id:subscription._id},{$set:{status:'active',isActive:true}});
   }return observed;};return query;
 });
 expect(await projectCurrentEntitlement(business._id)).toBe(true);
 expect(interleaved).toBe(true);
 expect((await Business.findById(business._id)).setupProgress.subscriptionActivated).toBe(true);
 expect((await Subscription.findById(subscription._id)).status).toBe('active');
});
test('projection preserves the account suspension flag and applies current trial controls',async()=>{
 const {business,subscription}=await trackingFixture();
 await Business.updateOne({_id:business._id},{$set:{isActive:false}});
 await Subscription.updateOne({_id:subscription._id},{$set:{status:'trialing',trialEndsAt:new Date(Date.now()+86400000)}});
 await projectCurrentEntitlement(business._id);
 const row=await Business.findById(business._id);
 expect(row.isActive).toBe(false);expect(row.setupProgress.subscriptionActivated).toBe(true);expect(row.trialCostControls.enabled).toBe(true);
});
