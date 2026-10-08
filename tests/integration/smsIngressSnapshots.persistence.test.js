import AutomationJob from "../../src/models/automationJob.js";
import CallLog from "../../src/models/callLog.js";
import AutomationService from "../../src/services/automation/automation.service.js";
import {linkRecentTrackedCalls} from "../../src/services/messaging/trackedCallLink.service.js";
import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import WebhookEvent from '../../src/models/webhookEvent.js';
import {getOrCreateSmsLeadAndConversation} from '../../src/services/messaging/smsConversation.service.js';
import {completeTwilioWebhookEvent} from '../../src/services/webhooks/twilioWebhookEvent.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
const id=()=>new mongoose.Types.ObjectId();
const phone='+14045550100';
beforeAll(connectTestDB,60000);afterEach(clearTestDB);afterAll(closeTestDB);
async function seed() {
 const tenants=Array.from({length:2},(_,i)=>({business:{_id:id(),businessName:`Tenant ${i}`},lead:id(),conversation:id(),appointment:id()}));
 await Business.collection.insertMany(tenants.map(t=>t.business));
 await Lead.collection.insertMany(tenants.map(t=>({_id:t.lead,business:t.business._id,phone,phoneLookup:phone,notes:'Saved notes',customerName:'Saved customer',status:'booked',serviceNeeded:'HVAC repair',address:'123 Test Street',preferredAppointmentTime:'Friday noon',appointment:t.appointment})));
 await Conversation.collection.insertMany(tenants.map(t=>({_id:t.conversation,business:t.business._id,lead:t.lead,customerPhone:phone,customerPhoneLookup:phone,activeRecord:true,status:'closed',humanTakeover:true,aiEnabled:false,bookingState:{status:'booked',appointment:t.appointment},conversationMemory:{recoveryIntake:{accepted:true,preferredAppointmentTime:'Friday noon'}},lastMessageAt:new Date()})));
 return tenants;
}
test('concurrent read-only SMS ingress preserves each tenant, appointment, closed state and staff ownership',async()=>{
 const tenants=await seed();
 const results=await Promise.all(tenants.map((t,i)=>getOrCreateSmsLeadAndConversation({business:t.business,customerPhone:phone,body:`New message ${i}`,readOnly:true})));
 results.forEach((r,i)=>{
  const t=tenants[i];expect(r.lead).not.toBeInstanceOf(mongoose.Document);expect(r.conversation).not.toBeInstanceOf(mongoose.Document);
  expect(String(r.lead._id)).toBe(String(t.lead));expect(String(r.conversation._id)).toBe(String(t.conversation));
  expect(String(r.conversation.bookingState.appointment)).toBe(String(t.appointment));
  expect(r.conversation).toMatchObject({status:'closed',humanTakeover:true,aiEnabled:false,lastMessage:`New message ${i}`});
  expect(r.lead).toMatchObject({status:'booked',serviceNeeded:'HVAC repair',address:'123 Test Street',preferredAppointmentTime:'Friday noon'});
 });
 expect(await Conversation.countDocuments({})).toBe(2);expect(await Lead.countDocuments({})).toBe(2);
 const rows=await Conversation.find({}).lean();expect(rows.every(r=>r.humanTakeover===true&&r.aiEnabled===false&&r.status==='closed')).toBe(true);
});
test('ordinary shared-service callers still receive documents they can save',async()=>{
 const [t]=await seed();
 const result=await getOrCreateSmsLeadAndConversation({business:t.business,customerPhone:phone,body:'Incoming'});
 expect(result.lead).toBeInstanceOf(mongoose.Document);expect(result.conversation).toBeInstanceOf(mongoose.Document);
 result.lead.notes='Updated by ordinary caller';await result.lead.save();
 expect((await Lead.findById(t.lead).lean()).notes).toBe('Updated by ordinary caller');
});
test('read-only completion cannot complete a stale lease owner and preserves replay response',async()=>{
 const event=await WebhookEvent.create({business:id(),eventType:'inbound_sms',eventKey:'lease',providerEventId:'SM1',status:'processing',leaseToken:'winner'});
 expect(await completeTwilioWebhookEvent(event._id,{leaseToken:'stale',readOnly:true,responseBody:'wrong'})).toBeNull();
 const result=await completeTwilioWebhookEvent(event._id,{leaseToken:'winner',readOnly:true,responseBody:'<Response/>'});
 expect(result).not.toBeInstanceOf(mongoose.Document);expect(result.status).toBe('completed');expect(result.responseBody).toBe('<Response/>');
 expect(await completeTwilioWebhookEvent(event._id,{leaseToken:'winner',readOnly:true,responseBody:'replace'})).toBeNull();
 expect((await WebhookEvent.findById(event._id).lean()).responseBody).toBe('<Response/>');
});

test('batched follow-up cancellation leaves foreign and completed jobs untouched',async()=>{
 const [a,b]=await seed();const foreign=id(),done=id();
 await AutomationJob.init();
 await AutomationJob.create([
  {_id:id(),business:a.business._id,lead:a.lead,conversation:a.conversation,status:'scheduled'},
  {_id:id(),business:b.business._id,lead:b.lead,conversation:b.conversation,status:'processing'},
  {_id:foreign,business:a.business._id,lead:b.lead,conversation:b.conversation,status:'scheduled'},
  {_id:done,business:a.business._id,lead:a.lead,conversation:a.conversation,status:'completed'},
 ].map(job=>({...job,workflow:id(),action:'send_sms',template:'Test follow-up',
  executeAt:new Date(),idempotencyKey:`snapshot-test:${job._id}`})));
 await Promise.all([a,b].map(t=>AutomationService.cancelObsolete({businessId:t.business._id,leadId:t.lead,conversationId:t.conversation,reason:'customer_replied',batch:true})));
 expect(await AutomationJob.countDocuments({status:'canceled'})).toBe(2);
 expect((await AutomationJob.findById(foreign).lean()).status).toBe('scheduled');
 expect((await AutomationJob.findById(done).lean()).status).toBe('completed');
});
test('batched call linking preserves assigned records and same-phone tenant isolation',async()=>{
 const tenants=await seed();const assigned=id(),originalLead=id(),tracking=id(),now=new Date('2026-10-06T22:30:00Z');
 await CallLog.collection.insertMany([
  ...tenants.map(t=>({_id:id(),business:t.business._id,from:phone,lead:null,conversation:null,trackingNumber:tracking,createdAt:now,deletedAt:null})),
  {_id:assigned,business:tenants[0].business._id,from:phone,lead:originalLead,conversation:id(),trackingNumber:tracking,createdAt:now,deletedAt:null},
 ]);
 await Promise.all(tenants.map(t=>linkRecentTrackedCalls({businessId:t.business._id,leadId:t.lead,conversationId:t.conversation,phone,now,batch:true})));
 for(const t of tenants)expect(await CallLog.countDocuments({business:t.business._id,lead:t.lead,conversation:t.conversation})).toBe(1);
 expect(String((await CallLog.findById(assigned).lean()).lead)).toBe(String(originalLead));
});
