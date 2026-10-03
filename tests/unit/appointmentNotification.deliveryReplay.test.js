import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import Message from '../../src/models/message.js';
import Conversation from '../../src/models/conversation.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
import { processNextAppointmentNotification } from '../../src/services/scheduling/appointmentNotification.service.js';
jest.mock('../../src/models/appointmentNotificationJob.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn(),findById:jest.fn()}}));
jest.mock('../../src/models/message.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{updateOne:jest.fn()}}));
jest.mock('../../src/services/twilioSmsService.js',()=>({sendSms:jest.fn()}));
let job;
beforeEach(()=>{
 jest.clearAllMocks();
 job={_id:'job',key:'change_notice:business_approval_confirmed',type:'change_notice',body:'Confirmed for inspection',attempts:0,business:{_id:'business',phone:'+14045550111'},appointment:{_id:'appointment',status:'confirmed',conversation:'conversation',customerPhone:'+14045550123'},save:jest.fn().mockResolvedValue(null)};
 AppointmentNotificationJob.findOneAndUpdate.mockImplementation(async(filter,update)=>{Object.assign(job,update.$set);job.attempts+=1;return job;});
 const populated={populate:jest.fn()};populated.populate.mockReturnValueOnce(populated).mockImplementation(()=>Promise.resolve(job));
 AppointmentNotificationJob.findById.mockImplementation(()=>({populate:()=>({populate:()=>Promise.resolve(job)})}));
 sendSms.mockResolvedValue({sid:'SMreceipt',status:'queued'});
 Message.findOneAndUpdate.mockResolvedValue({});Conversation.updateOne.mockResolvedValue({});
});
test('persistence failure after provider acceptance replays stable operation identity and upserts receipt',async()=>{
 Message.findOneAndUpdate.mockRejectedValueOnce(new Error('database timeout')).mockResolvedValueOnce({});
 expect((await processNextAppointmentNotification()).status).toBe('scheduled');
 expect((await processNextAppointmentNotification()).status).toBe('sent');
 expect(sendSms.mock.calls[0][0].metadata.idempotencyKey).toBe(sendSms.mock.calls[1][0].metadata.idempotencyKey);
 expect(Message.findOneAndUpdate).toHaveBeenCalledWith({business:'business',provider:'twilio',providerMessageId:'SMreceipt'},{$setOnInsert:expect.any(Object)},{upsert:true,new:true});
});
test('canceled appointment cannot send a stale approval confirmation',async()=>{
 job.appointment.status='canceled';expect((await processNextAppointmentNotification()).status).toBe('canceled');expect(sendSms).not.toHaveBeenCalled();
});
test('STOP suppression remains canceled and never creates message receipt',async()=>{
 sendSms.mockResolvedValue({suppressed:true,reason:'opted_out'});
 expect(await processNextAppointmentNotification()).toMatchObject({status:'canceled',failureReason:'opted_out'});expect(Message.findOneAndUpdate).not.toHaveBeenCalled();
});
test('uncertain provider result never records a sent confirmation',async()=>{
 sendSms.mockRejectedValue(Object.assign(new Error('provider outcome uncertain'),{deliveryUncertain:true}));
 expect((await processNextAppointmentNotification()).status).toBe('scheduled');expect(Message.findOneAndUpdate).not.toHaveBeenCalled();
});
test('old staff confirmation cannot send after a newer cancellation event',async()=>{
 job.key='change_notice:lifecycle_confirmed';job.appointment.lifecycleNotice={key:'lifecycle_canceled'};job.appointment.status='canceled';
 expect((await processNextAppointmentNotification()).status).toBe('canceled');expect(sendSms).not.toHaveBeenCalled();
});
test('staff cancellation notice sends once using the shared delivery identity',async()=>{
 job.key='change_notice:lifecycle_canceled';job.appointment.lifecycleNotice={key:'lifecycle_canceled'};job.appointment.status='canceled';
 expect((await processNextAppointmentNotification()).status).toBe('sent');
 expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({source:'appointment_change_notice',metadata:expect.objectContaining({appointmentNotificationKey:job.key})}));
});
