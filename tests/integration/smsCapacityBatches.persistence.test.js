import mongoose from 'mongoose';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import WebhookEvent from '../../src/models/webhookEvent.js';
import {createFreshFindOneBatch} from '../../src/services/database/freshFindOneBatch.js';
import {createAwaitedInsertBatch} from '../../src/services/database/awaitedInsertBatch.js';
import {getOrCreateSmsLeadAndConversation} from '../../src/services/messaging/smsConversation.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
const id=()=>new mongoose.Types.ObjectId();
beforeAll(async()=>{await connectTestDB();await Lead.init();await WebhookEvent.init();},60000);
afterEach(async()=>{jest.restoreAllMocks();await clearTestDB();});afterAll(closeTestDB);

test('fresh batched indexed find-one equals original sort/limit for legacy phones and tenant collisions',async()=>{
 const a=id(),b=id(),phone='+14045550100';
 const rows=[
  {_id:id(),business:a,phone,phoneLookup:phone,status:'open',lastMessageAt:new Date(1000)},
  {_id:id(),business:a,phone:'4045550100',status:'closed',humanTakeover:true,aiEnabled:false,lastMessageAt:new Date(2000)},
  {_id:id(),business:a,phone,phoneLookup:phone,status:'archived',lastMessageAt:new Date(3000)},
  {_id:id(),business:b,phone,phoneLookup:phone,status:'open',lastMessageAt:new Date(5000)},
 ];
 await Conversation.collection.insertMany(rows.map(r=>({...r,customerPhone:r.phone,customerPhoneLookup:r.phoneLookup})));
 const read=createFreshFindOneBatch(Conversation,{sort:{lastMessageAt:-1},defaults:true});
 const filter=business=>({business,status:{$ne:'archived'},$or:[{customerPhoneLookup:phone},{customerPhone:{$in:[phone,'4045550100']}}]});
 const aggregate=jest.spyOn(Conversation,'aggregate');
 const results=await Promise.all([a,b,id()].map(v=>read(filter(v))));
 expect(aggregate).toHaveBeenCalledTimes(1);
 expect(results[0]).toMatchObject({status:'closed',humanTakeover:true,aiEnabled:false});
 expect(String(results[0]._id)).toBe(String(rows[1]._id));
 expect(String(results[1].business)).toBe(String(b));expect(results[2]).toBeNull();
 await Conversation.collection.updateOne({_id:rows[1]._id},{$set:{status:'archived'}});
 const second=await Promise.all([read(filter(a)),read(filter(b))]);
 expect(String(second[0]._id)).toBe(String(rows[0]._id));expect(aggregate).toHaveBeenCalledTimes(2);
});

test('concurrent insertion attributes duplicates and validation errors without rejecting committed peers',async()=>{
 const business=id();
 const make=i=>({business,eventType:'inbound_sms',eventKey:`key${i}`,providerEventId:`SM${i}`,leaseToken:`lease${i}`});
 await WebhookEvent.create(make(0));
 const insert=createAwaitedInsertBatch(WebhookEvent);
 const results=await Promise.allSettled([insert(make(0)),insert(make(1)),insert({...make(2),eventType:'invalid'}),insert(make(3))]);
 expect(results[0].status).toBe('rejected');expect(results[0].reason.code).toBe(11000);
 expect(results[1].status).toBe('fulfilled');expect(results[2].status).toBe('rejected');expect(results[3].status).toBe('fulfilled');
 expect(await WebhookEvent.countDocuments()).toBe(3);
 expect(results[1].value.createdAt).toBeInstanceOf(Date);
 expect(results[1].value.duplicateCount).toBe(0);
});

test('an uncertain insert result rejects every affected caller and retries recover',async()=>{
 const business=id();const insert=createAwaitedInsertBatch(WebhookEvent);
 const spy=jest.spyOn(WebhookEvent,'insertMany').mockRejectedValueOnce(new Error('connection lost'));
 const rows=[0,1].map(i=>({business,eventType:'inbound_sms',eventKey:`err${i}`,providerEventId:`ERR${i}`}));
 const results=await Promise.allSettled(rows.map(insert));expect(results.every(r=>r.status==='rejected')).toBe(true);
 spy.mockRestore();await Promise.all(rows.map(insert));expect(await WebhookEvent.countDocuments()).toBe(2);
});

test('fresh read errors reject affected callers without poisoning subsequent reads',async()=>{
 const read=createFreshFindOneBatch(Lead,{sort:{updatedAt:-1}});
 const spy=jest.spyOn(Lead,'aggregate').mockRejectedValueOnce(new Error('read unavailable'));
 const results=await Promise.allSettled([read({_id:id()}),read({_id:id()})]);expect(results.every(r=>r.status==='rejected')).toBe(true);
 spy.mockRestore();expect(await Promise.all([read({_id:id()}),read({_id:id()})])).toEqual([null,null]);
});

test('batched conversation bookkeeping validates changes and preserves concurrent ownership and booking state',async()=>{
 const {updateSmsConversationSnapshot}=await import('../../src/services/messaging/smsConversationUpdateBatch.service.js');
 const business=id(),lead=id(),appointment=id();
 const rows=Array.from({length:40},(_,i)=>({_id:id(),business,lead,customerPhone:`+1404555${String(i).padStart(4,'0')}`,status:'closed',humanTakeover:true,aiEnabled:false,bookingState:{status:'booked',appointment}}));
 await Conversation.collection.insertMany(rows);
 const spy=jest.spyOn(Conversation,'bulkWrite');
 const results=await Promise.all(rows.map((row,i)=>updateSmsConversationSnapshot({businessId:business,conversationId:row._id,update:{lead,customerPhone:row.customerPhone,customerPhoneLookup:row.customerPhone,lastMessage:`Update ${i}`,lastMessageAt:new Date()}})));
 expect(spy).toHaveBeenCalledTimes(1);
 results.forEach((r,i)=>{expect(r).toMatchObject({status:'closed',humanTakeover:true,aiEnabled:false,lastMessage:`Update ${i}`});expect(String(r.bookingState.appointment)).toBe(String(appointment));});
 const bad=await Promise.allSettled(rows.slice(0,2).map(row=>updateSmsConversationSnapshot({businessId:business,conversationId:row._id,update:{lastMessageAt:'not-a-date'}})));
 expect(bad.every(r=>r.status==='rejected')).toBe(true);
 expect((await Conversation.findById(rows[0]._id).lean()).customerPhone).toBe(rows[0].customerPhone);
 await expect(updateSmsConversationSnapshot({businessId:id(),conversationId:rows[0]._id,update:{lastMessage:'Foreign'}})).rejects.toThrow();
});

test('batched distributed counters enforce the cap for a shared key and reset on a new window',async()=>{
 const Counter=(await import('../../src/models/communicationRouteRateLimit.js')).default;
 const {reserveMongoRouteCounter}=await import('../../src/services/database/routeCounterBatch.js');
 await Counter.init();const start=new Date();const identity={name:'test-sms',keyHash:'a'.repeat(64),windowStart:start};const expires=new Date(+start+180000);
 const results=await Promise.all(Array.from({length:20},()=>reserveMongoRouteCounter(identity,3,expires)));
 expect(results.filter(Boolean)).toHaveLength(3);expect((await Counter.findOne(identity).lean()).count).toBe(3);
 const other={...identity,windowStart:new Date(+start+60000)};
 expect(await reserveMongoRouteCounter(other,3,new Date(+expires+60000))).toBe(true);
 expect((await Counter.findOne(other).lean()).count).toBe(1);
});

test('a duplicate counter insert retries the still-under-limit atomic increment',async()=>{
 const Counter=(await import('../../src/models/communicationRouteRateLimit.js')).default;
 const {reserveMongoRouteCounter}=await import('../../src/services/database/routeCounterBatch.js');
 await Counter.init();const start=new Date();const identity={name:'test-race',keyHash:'b'.repeat(64),windowStart:start};const expires=new Date(+start+180000);
 await Counter.create({...identity,expiresAt:expires,count:1});
 const spy=jest.spyOn(Counter,'findOneAndUpdate').mockReturnValueOnce({lean:()=>Promise.reject(Object.assign(new Error('concurrent insert'),{code:11000}))});
 expect(await reserveMongoRouteCounter(identity,2,expires)).toBe(true);
 expect(spy).toHaveBeenCalledTimes(2);expect((await Counter.findOne(identity).lean()).count).toBe(2);
 expect(await reserveMongoRouteCounter(identity,2,expires)).toBe(false);
});

test('voice append batching preserves every turn and an explicit full-session read remains available',async()=>{
 const VoiceSession=(await import('../../src/models/voiceSession.js')).default;
 const Transcript=(await import('../../src/voice/voiceTranscript.service.js')).default;
 const a=await VoiceSession.create({business:id(),providerCallSid:'CA_BATCH_A',status:'active'});
 const b=await VoiceSession.create({business:id(),providerCallSid:'CA_BATCH_B',status:'active'});
 const result=await Promise.all([
  Transcript.append({sessionId:a._id,role:'customer',text:'Tenant A first'}),
  Transcript.append({sessionId:b._id,role:'customer',text:'Tenant B only'}),
  Transcript.append({sessionId:a._id,role:'assistant',text:'Tenant A second',isFinal:false}),
 ]);
 expect(result.every(s=>s._id && !Object.hasOwn(s,'transcript'))).toBe(true);
 expect((await VoiceSession.findById(a._id).lean()).transcript.map(e=>e.text)).toEqual(['Tenant A first','Tenant A second']);
 expect((await VoiceSession.findById(b._id).lean()).transcript.map(e=>e.text)).toEqual(['Tenant B only']);
 const full=await Transcript.append({sessionId:a._id,role:'customer',text:'Explicit full result',returnSession:true});
 expect(full).toBeInstanceOf(mongoose.Document);expect(full.transcript[1].isFinal).toBe(false);expect(full.transcript.at(-1).text).toBe('Explicit full result');
 const before=await VoiceSession.findById(a._id).lean();
 jest.spyOn(VoiceSession,'bulkWrite').mockRejectedValueOnce(new Error('write uncertain'));
 const failed=await Promise.allSettled([a,b].map(s=>Transcript.append({sessionId:s._id,role:'customer',text:'Uncertain'})));
 expect(failed.every(r=>r.status==='rejected')).toBe(true);
 expect((await VoiceSession.findById(a._id).lean()).transcript).toEqual(before.transcript);
});
