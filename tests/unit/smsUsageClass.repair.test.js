import crypto from 'node:crypto';
import Message from '../../src/models/message.js';
import Appointment from '../../src/models/appointment.js';
import Job from '../../src/models/appointmentNotificationJob.js';
import { resolveSmsUsageClass } from '../../src/services/messaging/smsUsageClass.service.js';
jest.mock('../../src/models/message.js', () => ({__esModule:true, default:{findOne:jest.fn()}}));
jest.mock('../../src/models/appointment.js', () => ({__esModule:true, default:{exists:jest.fn()}}));
jest.mock('../../src/models/appointmentNotificationJob.js', () => ({__esModule:true, default:{findOne:jest.fn()}}));
const businessId='64f000000000000000000001', inboundId='64f000000000000000000002';
const jobId='64f000000000000000000003', appointmentId='64f000000000000000000004';
const base={businessId,to:'+12025550123',from:'+12025550111',conversationId:'64f000000000000000000005'};
const reply={...base,directResponse:true,metadata:{inboundMessageId:inboundId},operationKey:`sms-inbound-reply:${businessId}:${inboundId}`};
const body='Your existing appointment remains confirmed.';
const notice={...base,source:'appointment_change_notice',body,metadata:{appointmentId,appointmentNotificationJobId:jobId,appointmentNotificationKey:'change_notice:lifecycle_declined'},operationKey:`appointment-notice:${businessId}:${jobId}:${crypto.createHash('sha256').update(body).digest('hex').slice(0,32)}`};
const query = value => ({select:()=>({lean:async()=>value})});
beforeEach(()=>{jest.clearAllMocks();Message.findOne.mockReturnValue(query({_id:inboundId}));Job.findOne.mockReturnValue(query({_id:jobId}));Appointment.exists.mockResolvedValue({_id:appointmentId});});
test('verified reply requires same business, conversation, sender and recipient',async()=>{
 expect(await resolveSmsUsageClass(reply)).toBe('reply');
 expect(Message.findOne).toHaveBeenCalledWith({_id:inboundId,business:businessId,conversation:base.conversationId,direction:'inbound',provider:'twilio',from:base.to,to:base.from,status:'received'});
});
test.each([{directResponse:true},{source:'inbound_sms_reply'}, {...reply,operationKey:'new-key'}, {...reply,metadata:{inboundMessageId:'invalid'}}])('flags or a fresh retry key cannot claim reply budget %#',async changes=>{expect(await resolveSmsUsageClass({...base,...changes})).toBe('proactive');expect(Message.findOne).not.toHaveBeenCalled();});
test('missing/cross-tenant inbound evidence cannot claim reply budget',async()=>{Message.findOne.mockReturnValue(query(null));expect(await resolveSmsUsageClass(reply)).toBe('proactive');});
test('verified claimed change notice receives appointment budget',async()=>{
 expect(await resolveSmsUsageClass(notice)).toBe('appointment');
 expect(Job.findOne).toHaveBeenCalledWith({_id:jobId,business:businessId,appointment:appointmentId,type:'change_notice',status:'processing',key:notice.metadata.appointmentNotificationKey,body});
 expect(Appointment.exists).toHaveBeenCalledWith({_id:appointmentId,business:businessId,customerPhone:base.to});
});
test.each([{source:'appointment_reminder'},{source:'appointment_follow_up'},{operationKey:'new-key'},{body:'different body'}])('proactive or altered notices do not claim appointment budget %#',async changes=>{expect(await resolveSmsUsageClass({...notice,...changes})).toBe('proactive');});
test('missing notice or wrong appointment recipient falls back to proactive',async()=>{Job.findOne.mockReturnValue(query(null));expect(await resolveSmsUsageClass(notice)).toBe('proactive');Job.findOne.mockReturnValue(query({_id:jobId}));Appointment.exists.mockResolvedValue(null);expect(await resolveSmsUsageClass(notice)).toBe('proactive');});

test('alternate ObjectId casing cannot mint a second reply operation',async()=>{
 const id='64fabcdef000000000000002';
 const spoof={...reply,metadata:{inboundMessageId:id.toUpperCase()},operationKey:`sms-inbound-reply:${businessId}:${id.toUpperCase()}`};
 expect(await resolveSmsUsageClass(spoof)).toBe('proactive');expect(Message.findOne).not.toHaveBeenCalled();
});
