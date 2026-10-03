import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import '../../src/models/business.js';
import User from '../../src/models/user.js';
import Alert from '../../src/models/alert.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import Message from '../../src/models/message.js';
import Appointment from '../../src/models/appointment.js';
import Lease from '../../src/models/productionOperationLease.js';
import { listBusinessRequests, readRequestWorkflow, updateRequestWorkflow } from '../../src/services/businessRequestWorkflow.service.js';
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertUpdated:jest.fn(),emitConversationUpdated:jest.fn(),emitLeadUpdated:jest.fn(),emitDashboardRefresh:jest.fn()}}));
let mongo,business,conversation,lead,alerts;
const oid=()=>new mongoose.Types.ObjectId();
beforeAll(async()=>{mongo=new MongoMemoryReplSet({replSet:{count:1},instanceOpts:[{launchTimeout:30000}]});await mongo.start();await mongoose.connect(mongo.getUri());await Alert.init();await Lease.init();},120000);
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();});
beforeEach(async()=>{
 if(mongoose.connection.readyState!==1)return;
 for(const collection of Object.values(mongoose.connection.collections))await collection.deleteMany({});
 business={_id:oid(),owner:oid()};conversation=oid();lead=oid();
 await User.collection.insertOne({_id:business.owner,userName:'Owner'});
 await Lead.collection.insertOne({_id:lead,business:business._id,customerName:'Missed Call Lead',phone:'+14045550100',serviceNeeded:'Toilet leaking and clogged',address:'907 Run Rd Atlanta GA 30324',preferredAppointmentTime:'Friday noon',status:'contacted',valuation:{source:'service_catalog'},estimatedValue:250});
 await Conversation.collection.insertOne({_id:conversation,business:business._id,lead,status:'open',aiEnabled:true,humanTakeover:false,customerPhone:'+14045550100',orchestration:{recoveryJourneyKey:'j1',recoveryJourneyStartedAt:new Date('2026-09-21T20:00:00Z')},conversationMemory:{recoveryIntake:{submitted:true,reviewReady:true,journeyKey:'j1'}},bookingState:{status:'not_started'}});
 alerts=[];for(let i=0;i<4;i++)alerts.push(await Alert.create({business:business._id,conversation,lead,type:'human_requested',actionRequired:true,status:'sent',priority:'high',title:i===3?'Request ready':'Urgent customer request',message:`Turn ${i}`,dedupeKey:`${i===3?'human_handoff':'ai_review'}:SM${i}`,metadata:i===3?{intakeReview:{reviewReady:true},handoffReason:'intake_complete'}:{}}));
});
const read=()=>readRequestWorkflow({businessId:business._id,alertId:alerts[0]._id});
const act=async(action,extra={})=>{const snapshot=await read();return updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input:{action,version:snapshot.version,operationId:`op-${oid()}`,...extra}});};
test('groups four legacy reviews before pagination; atomically accepts and consolidates with history',async()=>{
 const safety=await Alert.create({business:business._id,conversation,lead,type:'safety_emergency',actionRequired:true,title:'Safety',message:'Separate safety concern',priority:'critical'});
 const list=await listBusinessRequests({businessId:business._id,query:{}});expect(list.total).toBe(2);expect(list.data.find(row=>row.type==='human_requested').memberIds).toHaveLength(4);
 const result=await act('accept');expect(result.review.assignedTo.toString()).toBe(business.owner.toString());expect(result.conversation.humanTakeover).toBe(true);expect(result.conversation.aiEnabled).toBe(false);expect(result.conversation.humanTakeoverAt).toBeTruthy();expect(String(result.conversation.humanTakeoverBy)).toBe(String(business.owner));
 expect(await Alert.countDocuments({business:business._id,type:'human_requested',resolvedAt:null})).toBe(1);expect(result.review.reviewEvents.filter(event=>event.key.startsWith('legacy:'))).toHaveLength(4);
 expect((await Alert.findById(safety._id)).resolvedAt).toBeNull();
 expect(await Alert.countDocuments({'metadata.supersededBy':result.review._id.toString()})).toBe(3);
});
test('failure between acknowledgment and conversation write rolls the whole transaction back',async()=>{
 const write=jest.spyOn(Conversation,'updateOne').mockRejectedValueOnce(new Error('injected database failure'));
 await expect(act('accept')).rejects.toThrow('injected database failure');write.mockRestore();
 expect(await Alert.countDocuments({type:'human_requested',resolvedAt:null})).toBe(4);
 expect(await Alert.countDocuments({acknowledgedAt:{$ne:null}})).toBe(0);
 expect((await Conversation.findById(conversation)).humanTakeover).toBe(false);
});
test('staff corrections update authoritative facts, invalidate offers, and reject stale concurrent edits',async()=>{
 await act('accept');const before=await read();
 await act('facts',{changes:{customerName:'Jordan Lee',address:'123 Oak St Atlanta GA 30324',preferredAppointmentTime:'Monday afternoon'}});
 const after=await read();expect(after.lead.customerName).toBe('Jordan Lee');expect(after.conversation.conversationMemory.address).toBe('123 Oak St Atlanta GA 30324');expect(after.conversation.bookingState.selectedSlot).toBeNull();expect(after.lead.preferredAppointmentTime).toBe('Monday afternoon');
 await expect(updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input:{action:'facts',version:before.version,operationId:`stale-${oid()}`,changes:{address:'Stale address'}}})).rejects.toThrow('changed');
 expect((await Lead.findById(lead)).address).toBe('123 Oak St Atlanta GA 30324');
});
test('follow-up stays active and a replay of the same operation adds no duplicate history',async()=>{
 await act('accept');const snapshot=await read();const input={action:'outcome',outcome:'follow_up',reason:'Call to confirm customer name',followUpAt:new Date(Date.now()+86400000).toISOString(),operationId:`follow-${oid()}`,version:snapshot.version};
 const first=await updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input});
 const again=await updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input});
 await expect(updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input:{...input,reason:'A different action'}})).rejects.toThrow('different action');
 expect(again.review.resolvedAt).toBeNull();expect(again.review.actionRequired).toBe(true);expect(again.review.reviewEvents).toHaveLength(first.review.reviewEvents.length);expect(again.review.metadata.workflow.followUpAt).toEqual(new Date(input.followUpAt));
});
test('cannot invent a booked outcome, and closing a declined request leaves an audit trail',async()=>{
 await act('accept');await expect(act('outcome',{outcome:'booked',reason:'Requested Friday noon'})).rejects.toThrow('confirm');
 const result=await act('outcome',{outcome:'customer_declined',reason:'Customer chose another provider'});
 expect(result.review.resolvedAt).not.toBeNull();expect(result.lead.status).toBe('lost');expect(result.conversation.conversationMemory.recoveryIntake.review.status).toBe('resolved');
 expect(await Message.countDocuments()).toBe(0);
});
test('verified booking and message failure remain independent evidence',async()=>{
 await act('accept');const appointment=oid();await Appointment.collection.insertOne({_id:appointment,business:business._id,conversation,lead,status:'confirmed',startAt:new Date(),endAt:new Date(Date.now()+3600000)});
 await Conversation.updateOne({_id:conversation},{$set:{'bookingState.appointment':appointment,'bookingState.status':'booked'}});
 await Message.collection.insertOne({business:business._id,conversation,direction:'outbound',body:'Appointment notice',status:'failed',createdAt:new Date()});
 const result=await read();expect(result.appointment.status).toBe('confirmed');expect(result.latestOutbound.status).toBe('failed');
});
test('other businesses cannot read or mutate this customer request',async()=>{
 await expect(readRequestWorkflow({businessId:oid(),alertId:alerts[0]._id})).rejects.toMatchObject({statusCode:404});
 const list=await listBusinessRequests({businessId:oid(),query:{}});expect(list.total).toBe(0);
});

test('two simultaneous staff edits cannot overwrite each other',async()=>{
 await act('accept');const snapshot=await read();
 const results=await Promise.allSettled(['Jordan','Taylor'].map(customerName=>updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input:{action:'facts',version:snapshot.version,operationId:`race-${oid()}`,changes:{customerName}}})));
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
 const saved=await Lead.findById(lead);expect(['Jordan','Taylor']).toContain(saved.customerName);
});

test('delivery receipt between owner read and follow-up does not block outcome',async()=>{
 await act('accept');
 const message=await Message.create({business:business._id,conversation,lead,direction:'outbound',from:'+14045550200',to:'+14045550100',body:'Owner received your request',status:'sent'});
 const snapshot=await read();
 await Message.updateOne({_id:message._id},{$set:{status:'delivered'}});
 const result=await updateRequestWorkflow({business,userId:business.owner,alertId:alerts[0]._id,input:{action:'outcome',version:snapshot.version,operationId:`receipt-${oid()}`,outcome:'follow_up',reason:'Call to arrange the requested repair',followUpAt:new Date(Date.now()+86400000).toISOString()}});
 expect(result.review.metadata.workflow.outcome).toBe('follow_up');
 expect(result.review.actionRequired).toBe(true);
 expect(result.conversation.humanTakeover).toBe(true);
});
