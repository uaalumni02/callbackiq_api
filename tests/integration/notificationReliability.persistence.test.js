import mongoose from 'mongoose';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
import Alert from '../../src/models/alert.js';
import Business from '../../src/models/business.js';
import Policy from '../../src/models/schedulingPolicy.js';
import SmsJob from '../../src/models/smsProcessingJob.js';
import { runStaffSms } from '../../src/services/staffSms.service.js';
const oid = () => new mongoose.Types.ObjectId();
let business, alert, phone;
beforeAll(async () => { await connectTestDB(); await SmsJob.createIndexes(); }, 120000);
beforeEach(async () => {
 business=oid(); alert=oid(); phone='+14045550111'; process.env.CLIENT_URL='https://callbackiq.test';
 await Business.collection.insertOne({_id:business,isActive:true});
 await Policy.collection.insertOne({business,staffSmsEnabled:true,staffSmsPhone:phone});
 await Alert.collection.insertOne({_id:alert,business,lead:oid(),priority:'critical',actionRequired:true,resolvedAt:null,acknowledgedAt:null,dueAt:new Date(Date.now()+60000),metadata:{}});
});
afterEach(async () => { await clearTestDB(); delete process.env.CLIENT_URL; });
afterAll(closeTestDB);
test('competing workers send one initial text and never acknowledge on provider acceptance', async () => {
 const send=jest.fn().mockResolvedValue({sid:'SM-test'});
 await Promise.all([runStaffSms({send}),runStaffSms({send})]);
 expect(send).toHaveBeenCalledTimes(1);
 const record=await Alert.findById(alert).lean();
 expect(record.metadata.staffSms.initial).toMatchObject({state:'sent',providerMessageId:'SM-test'});
 expect(record.acknowledgedAt).toBeNull();
 expect(send.mock.calls[0][0].body).toContain('leadId=');
 await runStaffSms({send}); expect(send).toHaveBeenCalledTimes(1);
});
test('an overdue reminder is sent once; acknowledgment stops subsequent dispatch', async () => {
 const send=jest.fn().mockResolvedValue({sid:'SM-test'});
 await runStaffSms({send});
 await Alert.updateOne({_id:alert},{$set:{dueAt:new Date(Date.now()-1000)}});
 await runStaffSms({send}); await runStaffSms({send}); expect(send).toHaveBeenCalledTimes(2);
 await Alert.updateOne({_id:alert},{$set:{acknowledgedAt:new Date()},$unset:{'metadata.staffSms':1}});
 await runStaffSms({send}); expect(send).toHaveBeenCalledTimes(2);
});
test('owner opt-in, tenant scope and approval separation are required', async () => {
 await Policy.updateOne({business},{$set:{staffSmsEnabled:false}});
 const send=jest.fn(); await runStaffSms({send}); expect(send).not.toHaveBeenCalled();
 await Policy.updateOne({business},{$set:{staffSmsEnabled:true}});
 await Alert.updateOne({_id:alert},{$set:{'metadata.approvalRequest':true}});
 await Alert.collection.insertOne({_id:oid(),business:oid(),priority:'critical',actionRequired:true});
 await runStaffSms({send}); expect(send).not.toHaveBeenCalled();
});
test('ambiguous provider acceptance is retained and never replayed as an initial text', async () => {
 const send=jest.fn().mockRejectedValue(Object.assign(new Error('timeout'),{deliveryUncertain:true}));
 await runStaffSms({send}); await runStaffSms({send}); expect(send).toHaveBeenCalledTimes(1);
 expect((await Alert.findById(alert).lean()).metadata.staffSms.initial.state).toBe('uncertain');
});
test('claim-order index avoids a blocking sort under synthetic backlog', async () => {
 const now=new Date();
 await SmsJob.collection.insertMany(Array.from({length:3000},(_,i)=>({business,conversation:oid(),lead:oid(),inboundMessage:oid(),status:i%2?'queued':'retry',attemptCount:0,maxAttempts:5,priority:i%100,availableAt:new Date(now-i*1000),createdAt:new Date(now-i*1000)})));
 const filter={$expr:{$lt:['$attemptCount','$maxAttempts']},$or:[{status:'queued',availableAt:{$lte:now}},{status:'retry',availableAt:{$lte:now}},{status:'processing',leaseExpiresAt:{$lte:now}}]};
 const plan=await SmsJob.find(filter).sort({priority:-1,availableAt:1,createdAt:1}).limit(1).explain('executionStats');
 expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toMatch(/"stage":"SORT"/);
 expect(plan.executionStats.nReturned).toBe(1);
 expect(plan.executionStats.totalDocsExamined).toBeLessThan(100);
});
