import mongoose from 'mongoose';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import Lead from '../../src/models/lead.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import Alert from '../../src/models/alert.js';
import Job from '../../src/models/staffNotificationJob.js';
import { getLeadsPage, getMessagesPage, getConversationsPage } from '../../src/services/cursorPagination.service.js';
import { runConversationLifecycleOnce } from '../../src/workers/conversationLifecycle.worker.js';
import { runStaffNotificationsOnce } from '../../src/services/staffNotification.service.js';
jest.mock('../../src/services/twilioSmsService.js', () => ({ sendSms: jest.fn() }));
jest.mock('../../src/services/socket.service.js', () => ({ __esModule:true, default:{emitAlertUpdated:jest.fn(),emitDashboardRefresh:jest.fn()} }));
beforeAll(async()=>{await connectTestDB();await Job.init();},120000);
afterEach(async()=>{delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;if (mongoose.connection.readyState === 1) await clearTestDB();});
afterAll(async()=>{if(mongoose.connection.readyState === 1) await closeTestDB();});
const oid=()=>new mongoose.Types.ObjectId();
test('latest messages remain chronological and all 205 messages are reachable without overlap',async()=>{
 const conversation=oid();
 await Message.collection.insertMany(Array.from({length:205},(_,i)=>({_id:oid(),conversation,body:String(i),createdAt:new Date(1700000000000+i)})));
 const first=await getMessagesPage(conversation,{order:'latest'});
 expect(first.items[0].body).toBe('105');expect(first.items.at(-1).body).toBe('204');
 const second=await getMessagesPage(conversation,{order:'latest',cursor:first.nextCursor});
 const third=await getMessagesPage(conversation,{order:'latest',cursor:second.nextCursor});
 expect(new Set([...first.items,...second.items,...third.items].map(x=>String(x._id))).size).toBe(205);
 expect(third.hasMore).toBe(false);
 const legacy=await getMessagesPage(conversation,{});expect(legacy.items[0].body).toBe('0');
});
test('search can reach leads and conversations outside the first page and remains tenant scoped',async()=>{
 const business=oid(), foreign=oid(), lead=oid();
 await Lead.collection.insertMany(Array.from({length:61},(_,i)=>({_id:i===0?lead:oid(),business,customerName:i===0?'Older customer':'Other',serviceNeeded:i===0?'Furnace repair':'Plumbing',createdAt:new Date(1700000000000+i)})));
 await Lead.collection.insertOne({_id:oid(),business:foreign,customerName:'Older customer',createdAt:new Date()});
 expect((await getLeadsPage(business,{q:'Older customer'})).items).toHaveLength(1);
 await Conversation.collection.insertMany([{_id:oid(),business,lead,createdAt:new Date(),lastMessageAt:new Date()},{_id:oid(),business:foreign,customerName:'Furnace repair',createdAt:new Date()}]);
 expect((await getConversationsPage(business,{q:'Furnace repair'})).items).toHaveLength(1);
});
test('101 idle conversations cannot permanently hide later lifecycle work',async()=>{
 const business=oid();
 await Conversation.collection.insertMany(Array.from({length:101},(_,i)=>({_id:oid(),business,status:'open',aiEnabled:true,lastMessageAt:new Date(1700000000000+i),lifecycle:{recoveryNudgeCount:0}})));
 await runConversationLifecycleOnce();
 expect(await Conversation.countDocuments({'lifecycle.lastScannedAt':{$ne:null}})).toBe(100);
 await runConversationLifecycleOnce({now:new Date(Date.now()+60000)});
 expect(await Conversation.countDocuments({'lifecycle.lastScannedAt':{$ne:null}})).toBe(101);
});
async function fixture(){
 const business=oid(),owner=oid(),alert=oid();
 await User.collection.insertOne({_id:owner,email:'owner@example.test',emailVerifiedAt:new Date()});
 await Business.collection.insertOne({_id:business,owner,isActive:true,businessName:'Test'});
 await Alert.collection.insertOne({_id:alert,business,type:'human_requested',title:'Review',message:'Review',priority:'high',actionRequired:true,acknowledgedAt:null,resolvedAt:null,createdAt:new Date(),dueAt:new Date(Date.now()+600000)});
 process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';return {business,owner,alert};
}
test('parallel workers send one email; replay does not resend or acknowledge staff',async()=>{
 const {alert}=await fixture();const send=jest.fn().mockResolvedValue({accepted:['owner@example.test'],messageId:'id'});
 await Promise.all(Array.from({length:4},()=>runStaffNotificationsOnce({send})));
 expect(send).toHaveBeenCalledTimes(1);expect(await Job.countDocuments({status:'accepted'})).toBe(1);
 await runStaffNotificationsOnce({send});expect(send).toHaveBeenCalledTimes(1);
 expect((await Alert.findById(alert)).acknowledgedAt).toBeNull();
});
test('ambiguous provider failure is not retried, and stale sending jobs become uncertain',async()=>{
 const {alert,business}=await fixture();const send=jest.fn().mockRejectedValue(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}));
 await runStaffNotificationsOnce({send});await runStaffNotificationsOnce({send});expect(send).toHaveBeenCalledTimes(1);
 expect((await Job.findOne({alert})).status).toBe('uncertain');
 await Job.create({alert,business,stage:'overdue',status:'sending',leaseToken:'old',leaseExpiresAt:new Date(0)});
 await runStaffNotificationsOnce({send});expect((await Job.findOne({alert,stage:'overdue'})).status).toBe('uncertain');
});
test('acknowledged requests are not emailed',async()=>{
 const {alert}=await fixture();await Alert.updateOne({_id:alert},{$set:{acknowledgedAt:new Date()}});
 const send=jest.fn();await runStaffNotificationsOnce({send});expect(send).not.toHaveBeenCalled();
});
