import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import { buildBusinessReadiness } from '../../src/services/businessReadiness.service.js';
import { getTradeSetup } from '../../src/services/trades/tradeSetup.service.js';
let replica;
beforeAll(async()=>{
 replica=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(replica.getUri());
 await Business.init();await ServiceOffering.init();
},120000);
afterEach(async()=>{for(const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});});
afterAll(async()=>{await mongoose.disconnect();await replica?.stop();});
async function businessFixture(pending=true,businessType='hvac') {
 const business=await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'New home service',businessType,forwardingPhone:'+14045550111',trackingNumber:{status:'active'},setupProgress:{suggestedServicesPending:pending,smsRecoveryTested:true,inboxTested:false}});
 await Subscription.create({business:business._id,status:'active',isActive:true,stripeSubscriptionId:'sub_fixture'});
 return business;
}
async function complete(business) {
 await Business.updateOne({_id:business._id},{$set:{'setupProgress.inboxTested':true}});
 return buildBusinessReadiness(business._id);
}
test.each(['hvac','plumbing'])('new %s onboarding activates discussable services without booking permission',async trade=>{
 const business=await businessFixture(true,trade);
 await buildBusinessReadiness(business._id);expect(await ServiceOffering.countDocuments()).toBe(0);
 const readiness=await complete(business);const services=await ServiceOffering.find({business:business._id});
 expect(services.map(s=>s.name)).toEqual(expect.arrayContaining(getTradeSetup(trade).suggestedServices.map(s=>s.name)));
 expect(services).toHaveLength(7);
 for(const service of services) expect(service).toMatchObject({active:true,aiCanDiscuss:true,aiCanBook:false,requiresHumanReview:true});
 expect(readiness.checks.servicesConfigured).toBe(true);expect(readiness.states.bookingReady).toBe(false);
 expect((await Business.findById(business._id)).features.aiBookingEnabled).toBe(false);
 await Promise.all([buildBusinessReadiness(business._id),buildBusinessReadiness(business._id)]);
 expect(await ServiceOffering.countDocuments({business:business._id})).toBe(7);
});
test('existing businesses remain unchanged, including an empty catalog',async()=>{
 const business=await businessFixture(false);await complete(business);expect(await ServiceOffering.countDocuments()).toBe(0);
 const service=await ServiceOffering.create({business:business._id,name:'Owner custom service',active:false,aiCanDiscuss:false,aiCanBook:true});
 const before=service.toObject();await buildBusinessReadiness(business._id);
 expect((await ServiceOffering.findById(service._id).select('+nameKey')).toObject()).toEqual(before);expect(await ServiceOffering.countDocuments()).toBe(1);
});
test('new onboarding preserves an owner-configured catalog and consumes eligibility only once',async()=>{
 const business=await businessFixture();const service=await ServiceOffering.create({business:business._id,name:'Owner boiler visit',active:false,aiCanBook:true});const before=service.toObject();
 await complete(business);expect(await ServiceOffering.countDocuments()).toBe(1);
 expect((await ServiceOffering.findById(service._id).select('+nameKey')).toObject()).toEqual(before);
 expect((await Business.findById(business._id)).setupProgress.suggestedServicesPending).toBe(false);
});
test('suggestion creation failure rolls back the claim and can be retried',async()=>{
 const business=await businessFixture();const create=jest.spyOn(ServiceOffering,'create').mockRejectedValueOnce(new Error('write failed'));
 await expect(complete(business)).rejects.toThrow('write failed');create.mockRestore();
 expect((await Business.findById(business._id)).setupProgress.suggestedServicesPending).toBe(true);
 expect(await ServiceOffering.countDocuments()).toBe(0);await complete(business);expect(await ServiceOffering.countDocuments()).toBe(7);
});
