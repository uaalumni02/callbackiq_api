import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Lead from '../../src/models/lead.js';
import '../../src/models/business.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import { beginValuation, finishValuation, updateOwnerLead, unknownEstimate } from '../../src/services/valuation/opportunityValuation.service.js';
let mongo, business, lead;
beforeAll(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());},120000);
afterAll(async()=>{await mongoose.disconnect();if(mongo)await mongo.stop();});
beforeEach(async()=>{await Lead.deleteMany({});await ServiceOffering.deleteMany({});business=new mongoose.Types.ObjectId();lead=await Lead.create({business,phone:'+14045550199',serviceNeeded:'Drain cleaning',...unknownEstimate()});await ServiceOffering.create({business,name:'Drain cleaning',estimatedValue:225});});
test('owner update wins while model work is in flight',async()=>{const ticket=await beginValuation(lead,business);await updateOwnerLead({lead,businessId:business,changes:{estimatedValue:0},actorId:'test'});expect(await finishValuation(ticket,{businessId:business,evidence:'Drain cleaning'})).toBeNull();const saved=await Lead.findById(lead._id).lean();expect(saved.estimatedValue).toBe(0);expect(saved.valuation.source).toBe('owner');});
test('later analysis reserves a new version; older work cannot overwrite it',async()=>{const old=await beginValuation(lead,business), latest=await beginValuation(lead,business);expect(await finishValuation(old,{businessId:business,evidence:'Drain cleaning'})).toBeNull();expect((await finishValuation(latest,{businessId:business,evidence:'Drain cleaning'})).estimatedValue).toBe(225);expect(await finishValuation(old,{businessId:business,evidence:'hello'})).toBeNull();});
test('automatic release is explicit and an unrelated edit preserves value',async()=>{await updateOwnerLead({lead,businessId:business,changes:{estimatedValue:900}});await updateOwnerLead({lead,businessId:business,changes:{customerName:'Changed'}});expect((await Lead.findById(lead._id)).estimatedValue).toBe(900);await updateOwnerLead({lead,businessId:business,changes:{valuationAction:'automatic'}});expect((await Lead.findById(lead._id)).estimatedValue).toBe(225);});
test('tenant filter prevents cross-business write and catalog access',async()=>{const other=new mongoose.Types.ObjectId();expect(await beginValuation(lead,other)).toBeNull();const ticket=await beginValuation(lead,business);expect(await finishValuation(ticket,{businessId:other,evidence:'Drain cleaning'})).toBeNull();});

test('booked reports use each canonical appointment once, preserving unknown and zero',async()=>{
 const {canonicalLeadValueStages,reportValueExpression,canonicalAppointmentValueStages}=await import('../../src/services/valuation/valuationReport.js');
 const appointments=mongoose.connection.db.collection('appointments');
 await appointments.deleteMany({});
 await appointments.insertMany([
  {business,lead:lead._id,status:'confirmed',estimatedValue:225,valuation:{source:'service_catalog'}},
  {business,lead:lead._id,status:'rescheduled',estimatedValue:1200},
  {business,lead:lead._id,status:'completed',estimatedValue:225,actualRevenue:300,valuation:{source:'service_catalog'}},
 ]);
 const [row]=await Lead.aggregate([{$match:{_id:lead._id}},...canonicalLeadValueStages(),{$project:{value:reportValueExpression,actualRevenue:1}}]);
 expect(row.value).toBe(225);expect(row.actualRevenue).toBe(300);
 await updateOwnerLead({lead,businessId:business,changes:{estimatedValue:0}});
 const [updated]=await Lead.aggregate([{$match:{_id:lead._id}},...canonicalLeadValueStages(),{$project:{value:reportValueExpression}}]);expect(updated.value).toBe(0);
 const [booked]=await appointments.aggregate([{$match:{business,status:'confirmed'}},...canonicalAppointmentValueStages(),{$project:{value:reportValueExpression}}]).toArray();expect(booked.value).toBe(0);
});

test('migration preserves legacy 1200 and owner values and is repeatable',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const oldId=new mongoose.Types.ObjectId(),ownerId=new mongoose.Types.ObjectId();
 await Lead.collection.insertMany([{_id:oldId,business,phone:'+14045550201',serviceNeeded:'Unknown',estimatedValue:1200},{_id:ownerId,business,phone:'+14045550202',serviceNeeded:'Unknown',estimatedValue:1200,valuation:{source:'owner'}}]);
 const run=()=>promisify(execFile)(process.execPath,['scripts/migrate-opportunity-valuations.mjs','--apply'],{env:{...process.env,MONGO_URL:mongo.getUri()}});
 await run();await run();
 const old=await Lead.collection.findOne({_id:oldId}),owner=await Lead.collection.findOne({_id:ownerId});
 expect(old.estimatedValue).toBe(1200);expect(old.valuation.source).toBe('legacy_unverified');expect(old.valuationVersion).toBe(1);expect(owner.estimatedValue).toBe(1200);expect(owner.valuation.source).toBe('owner');
},30000);
