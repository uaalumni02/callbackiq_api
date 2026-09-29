import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import '../../src/models/lead.js';
import '../../src/models/conversation.js';
import Service from '../../src/models/serviceOffering.js';
import Appointment from '../../src/models/appointment.js';
import Job from '../../src/models/appointmentNotificationJob.js';
import Alert from '../../src/models/alert.js';
import {listAppointmentPage} from '../../src/services/scheduling/appointmentList.service.js';
import {reconcileApprovalRequests} from '../../src/services/scheduling/approvalLifecycle.service.js';
import {listBusinessRequests} from '../../src/services/businessRequestWorkflow.service.js';
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertUpdated:jest.fn()}}));
let mongo,business,service;
const oid=()=>new mongoose.Types.ObjectId();
beforeAll(async()=>{mongo=new MongoMemoryReplSet({replSet:{count:1},instanceOpts:[{launchTimeout:30000}]});await mongo.start();await mongoose.connect(mongo.getUri());await Appointment.init();await Job.init();await Alert.init();},120000);
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();});
beforeEach(async()=>{
 if(mongoose.connection.readyState!==1)return;
 for(const collection of Object.values(mongoose.connection.collections))await collection.deleteMany({});
 business=oid();service=oid();const owner=oid();await User.collection.insertOne({_id:owner,userName:'Readiness test owner'});await Business.collection.insertOne({_id:business,owner,businessName:'Test shop',timezone:'America/New_York'});await Service.collection.insertOne({_id:service,business,name:'Repair'});
});
test('65 appointments with identical times paginate completely without another tenant',async()=>{
 const startAt=new Date(Date.now()+86400000);
 await Appointment.collection.insertMany(Array.from({length:65},(_,index)=>({_id:oid(),idempotencyKey:`readiness-page-${index}`,business,serviceOffering:service,status:'confirmed',startAt,endAt:new Date(+startAt+3600000)})));
 await Appointment.collection.insertOne({_id:oid(),business:oid(),idempotencyKey:'readiness-foreign',startAt,status:'confirmed'});
 let cursor=null;const ids=[];
 do{const page=await listAppointmentPage({businessId:business,query:{view:'all',pageSize:25,...(cursor?{cursor}:{})}});ids.push(...page.data.map(x=>String(x._id)));cursor=page.pagination.nextCursor;}while(cursor);
 expect(ids).toHaveLength(65);expect(new Set(ids).size).toBe(65);
});
test('crash after confirmed write repairs one outbox identity without resetting provider receipt',async()=>{
 const appointment=oid();await Appointment.collection.insertOne({_id:appointment,idempotencyKey:`readiness-${appointment}`,business,serviceOffering:service,status:'confirmed',requiresBusinessApproval:true,startAt:new Date(Date.now()+86400000),approvalRecovery:{reconciled:false}});
 await reconcileApprovalRequests();expect(await Job.countDocuments({appointment})).toBe(1);
 await Job.updateOne({appointment},{$set:{status:'sent',providerMessageId:'SMreceipt',sentAt:new Date()}});
 await Appointment.updateOne({_id:appointment},{$set:{'approvalRecovery.reconciled':false}});
 await reconcileApprovalRequests();expect(await Job.countDocuments({appointment})).toBe(1);
 expect((await Job.findOne({appointment}).lean()).providerMessageId).toBe('SMreceipt');
 expect((await Appointment.findById(appointment).lean()).approvalRecovery.reconciled).toBe(true);
});
test('expired approval appears in Requests and stays visible in handled history after decision',async()=>{
 const appointment=oid();await Appointment.collection.insertOne({_id:appointment,idempotencyKey:`readiness-${appointment}`,business,serviceOffering:service,status:'failed',requiresBusinessApproval:true,approvalDecisionAt:null,startAt:new Date(Date.now()+86400000),heldExpiresAt:new Date(Date.now()-1000),failureReason:'Appointment hold expired before confirmation.',approvalRecovery:{reconciled:false}});
 await reconcileApprovalRequests();
 expect((await listBusinessRequests({businessId:business,query:{resolved:'false'}})).total).toBe(1);
 expect((await listAppointmentPage({businessId:business,query:{view:'approvals'}})).data).toHaveLength(1);
 await Appointment.updateOne({_id:appointment},{$set:{status:'canceled','approvalRecovery.reconciled':false}});await reconcileApprovalRequests();
 expect((await listBusinessRequests({businessId:business,query:{resolved:'false'}})).total).toBe(0);
 expect((await listBusinessRequests({businessId:business,query:{resolved:'true'}})).total).toBe(1);
});
