import mongoose from 'mongoose';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import Message from '../../src/models/message.js';
import WebhookEvent from '../../src/models/webhookEvent.js';
import { readOnlySnapshot, withSnapshotDefaults } from '../../src/services/database/readOnlySnapshot.js';
const clone = value => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(value));
const oid = () => new mongoose.Types.ObjectId();
const json = value => JSON.parse(JSON.stringify(value));
afterEach(() => {jest.restoreAllMocks(); jest.useRealTimers();});
const cases = [
 [Conversation, {business:oid(),lead:oid(),customerPhone:'+14045550100'}],
 [Conversation, {business:oid(),lead:oid(),customerPhone:'+14045550100',status:'closed',humanTakeover:true,aiEnabled:false,bookingState:{status:'booked',appointment:oid(),offeredSlots:[],selectedSlot:null},conversationMemory:{recoveryIntake:{customerName:'Alice',accepted:true}}}],
 [Lead, {business:oid(),phone:'+14045550100',customerName:'Alice',status:'booked',appointment:oid(),preferredAppointmentTime:'Friday at noon'}],
 [Message, {business:oid(),conversation:oid(),direction:'inbound',from:'+14045550100',to:'+14045550101',body:'Please call me',deliveryEvents:[{_id:oid(),providerStatus:'delivered'}],metadata:{processingRequired:true}}],
 [WebhookEvent, {business:oid(),eventType:'inbound_sms',eventKey:'key',providerEventId:'SM1',status:'completed',responseStatusCode:200,responseBody:'<Response/>'}],
];
test.each(cases)('%p snapshot defaults preserve hydrated JSON, including legacy rows',async (Model,fields)=>{
 jest.useFakeTimers().setSystemTime(new Date('2026-10-06T22:30:00Z'));
 const raw={_id:oid(),...fields};
 const expected=json(Model.hydrate(clone(raw)).toObject());
 const result=withSnapshotDefaults(Model,clone(raw));
 for (const [path,type] of Object.entries(Model.schema.paths)) {
   if (type.instance === 'Date' && typeof type.defaultValue === 'function' && raw[path] === undefined) {
     expect(result[path]).toBeInstanceOf(Date);
     expect(Math.abs(result[path].getTime() - new Date(expected[path]).getTime())).toBeLessThan(1000);
     expected[path]=json(result[path]);
   }
 }
 if (Model === Message && raw.deliveryEvents?.[0]?.receivedAt === undefined) {
   expect(result.deliveryEvents[0].receivedAt).toBeInstanceOf(Date);
   expect(Math.abs(result.deliveryEvents[0].receivedAt.getTime() - new Date(expected.deliveryEvents[0].receivedAt).getTime())).toBeLessThan(1000);
   expected.deliveryEvents[0].receivedAt=json(result.deliveryEvents[0].receivedAt);
 }
 expect(result).not.toBeInstanceOf(mongoose.Document);expect(json(result)).toEqual(expected);
});
test('native Mongoose query returns plain snapshot with fresh values; ordinary callers retain documents',async()=>{
 const raw={_id:oid(),business:oid(),customerPhone:'+14045550100',humanTakeover:false};
 const spy=jest.spyOn(Conversation.collection,'findOne').mockImplementation(async()=>clone(raw));
 const first=await readOnlySnapshot(Conversation,Conversation.findById(raw._id));
 expect(first.humanTakeover).toBe(false);expect(first).not.toBeInstanceOf(mongoose.Document);
 raw.humanTakeover=true;
 const second=await readOnlySnapshot(Conversation,Conversation.findById(raw._id));
 expect(second.humanTakeover).toBe(true);expect(first.humanTakeover).toBe(false);
 const hydrated=await readOnlySnapshot(Conversation,Conversation.findById(raw._id),false);
 expect(hydrated).toBeInstanceOf(mongoose.Document);expect(spy).toHaveBeenCalledTimes(3);
});
test('snapshot query retains update casting, phone middleware and validation',async()=>{
 const business=oid(), id=oid();
 const spy=jest.spyOn(Conversation.collection,'findOneAndUpdate').mockImplementation(async()=>({_id:id,business,customerPhone:'+14045550100',status:'open'}));
 await readOnlySnapshot(Conversation,Conversation.findByIdAndUpdate(String(id),{customerPhone:'4045550100'},{returnDocument:'after',runValidators:true}));
 const [filter,update]=spy.mock.calls[0];
 expect(filter._id).toEqual(id);expect(update.$set.customerPhone).toBe('+14045550100');expect(update.$set.customerPhoneLookup).toBe('+14045550100');
 await expect(readOnlySnapshot(Conversation,Conversation.findByIdAndUpdate(id,{status:'not-a-status'},{runValidators:true}))).rejects.toThrow();expect(spy).toHaveBeenCalledTimes(1);
});
test('missing rows remain null and database failures propagate',async()=>{
 const query={lean:jest.fn().mockResolvedValue(null)};
 expect(await readOnlySnapshot(Conversation,query)).toBeNull();
 const error=new Error('database unavailable');query.lean.mockRejectedValue(error);
 await expect(readOnlySnapshot(Conversation,query)).rejects.toBe(error);
});
