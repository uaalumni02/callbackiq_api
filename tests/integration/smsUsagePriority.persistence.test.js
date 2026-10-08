import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import twilio from 'twilio';
import Business from '../../src/models/business.js';
import Message from '../../src/models/message.js';
import Appointment from '../../src/models/appointment.js';
import Job from '../../src/models/appointmentNotificationJob.js';
import Usage from '../../src/models/communicationUsage.js';
import Reservation from '../../src/models/communicationUsageReservation.js';
import { isSmsSuppressed } from '../../src/services/messaging/contactPreference.service.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
jest.mock('twilio',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{createSystemAlert:jest.fn()}}));
jest.mock('../../src/services/outboundSmsAudit.service.js',()=>({recordOutboundSmsAudit:jest.fn()}));
jest.mock('../../src/services/messaging/contactPreference.service.js',()=>({isSmsSuppressed:jest.fn(),optOutSms:jest.fn()}));
jest.mock('../../src/services/smsContactDisclosure.service.js',()=>({claimSmsContactDisclosure:async()=>({append:false}),commitSmsContactDisclosure:jest.fn(),releaseSmsContactDisclosure:jest.fn()}));
let mongo,business,provider;
const customer='+12025550123';
const conversationId=new mongoose.Types.ObjectId();
const send=(extra={})=>sendSms({business,to:customer,body:'Test appointment message.',bypassQuietHours:true,...extra});
async function inbound(){
 const _id=new mongoose.Types.ObjectId();
 await Message.collection.insertOne({_id,business:business._id,conversation:conversationId,direction:'inbound',provider:'twilio',status:'received',from:customer,to:business.phone,providerMessageId:`SM${_id}`});
 return {directResponse:true,conversationId,source:'inbound_sms_deterministic_reply',metadata:{inboundMessageId:String(_id),idempotencyKey:`sms-inbound-reply:${business._id}:${_id}`}};
}
async function notice(){
 const appointmentId=new mongoose.Types.ObjectId(),jobId=new mongoose.Types.ObjectId();const body='Your existing appointment remains confirmed.';
 await Appointment.collection.insertOne({_id:appointmentId,business:business._id,customerPhone:customer,status:'confirmed'});
 await Job.collection.insertOne({_id:jobId,business:business._id,appointment:appointmentId,type:'change_notice',status:'processing',body,key:'change_notice:lifecycle_declined'});
 return {source:'appointment_change_notice',body,metadata:{appointmentId:String(appointmentId),appointmentNotificationJobId:String(jobId),appointmentNotificationKey:'change_notice:lifecycle_declined',idempotencyKey:`appointment-notice:${business._id}:${jobId}:${crypto.createHash('sha256').update(body).digest('hex').slice(0,32)}`}};
}
beforeAll(async()=>{
 mongo=await MongoMemoryReplSet.create({binary:{version:'7.0.24'},replSet:{count:1}});
 await mongoose.connect(mongo.getUri());await Promise.all([Usage.init(),Reservation.init(),Message.init(),Job.init()]);
 process.env.TWILIO_ACCOUNT_SID='AC00000000000000000000000000000000';process.env.TWILIO_AUTH_TOKEN='test-synthetic-token';
 provider=jest.fn().mockImplementation(async()=>({sid:`SM${crypto.randomBytes(16).toString('hex')}`,status:'queued'}));
 twilio.mockReturnValue({messages:{create:provider}});
},120000);
beforeEach(async()=>{
 if(mongoose.connection.readyState!==1)throw new Error('Disposable replica set unavailable; do not run against a real database.');
 await Promise.all([Usage.deleteMany({}),Reservation.deleteMany({}),Message.deleteMany({}),Job.deleteMany({}),Appointment.deleteMany({}),Business.deleteMany({})]);
 business={_id:new mongoose.Types.ObjectId(),phone:'+12025550111',isActive:true,communicationLimits:{smsCustomerHourly:4,smsCustomerDaily:120,smsBusinessHourly:300,smsBusinessDaily:3000}};
 await Business.collection.insertOne(business);provider.mockClear();isSmsSuppressed.mockResolvedValue(false);
});
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();});
test('same handset receives replies and decline after proactive exhaustion; replays send once',async()=>{
 for(let i=0;i<4;i++)expect((await send()).sid).toBeTruthy();
 expect(await send()).toMatchObject({policyBlocked:true,reason:'customer_hour_sms_outbound_limit'});
 const reply=await inbound();expect((await send(reply)).sid).toBeTruthy();await send(reply);
 for(let i=0;i<14;i++)expect((await send(await inbound())).sid).toBeTruthy();
 const decline=await notice();const result=await send(decline);expect(result.sid).toBeTruthy();expect((await send(decline)).sid).toBe(result.sid);
 expect(provider).toHaveBeenCalledTimes(20);
 expect(await send()).toMatchObject({policyBlocked:true,reason:'customer_hour_sms_outbound_limit'});
 expect(await Reservation.countDocuments({state:'committed'})).toBe(20);
});
test('concurrent duplicate reply operations call provider at most once',async()=>{
 const reply=await inbound();const results=await Promise.allSettled([send(reply),send(reply),send(reply)]);
 expect(results.some(result=>result.status==='fulfilled'&&result.value.sid)).toBe(true);
 expect(provider).toHaveBeenCalledTimes(1);expect(await Reservation.countDocuments({state:'committed'})).toBe(1);
});
test('forged and cross-business inbound context cannot bypass proactive quota',async()=>{
 for(let i=0;i<4;i++)await send();
 const reply=await inbound();await Message.updateOne({_id:reply.metadata.inboundMessageId},{$set:{business:new mongoose.Types.ObjectId()}});
 expect(await send(reply)).toMatchObject({policyBlocked:true,reason:'customer_hour_sms_outbound_limit'});expect(provider).toHaveBeenCalledTimes(4);
});
test('opt-out, daily and business caps apply to appointment notices',async()=>{
 const noticePayload=await notice();isSmsSuppressed.mockResolvedValue(true);
 expect(await send(noticePayload)).toMatchObject({suppressed:true,reason:'customer_opted_out'});expect(provider).not.toHaveBeenCalled();
 isSmsSuppressed.mockResolvedValue(false);business.communicationLimits.smsCustomerDaily=1;
 expect((await send(await inbound())).sid).toBeTruthy();expect(await send(noticePayload)).toMatchObject({policyBlocked:true,reason:'customer_day_sms_outbound_limit'});
});
