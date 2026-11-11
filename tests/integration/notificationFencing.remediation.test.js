import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Appointment from '../../src/models/appointment.js';
import Conversation from '../../src/models/conversation.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import Job from '../../src/models/appointmentNotificationJob.js';
import { sendSms } from '../../src/services/twilioSmsService.js';
import { processNextAppointmentNotification } from '../../src/services/scheduling/appointmentNotification.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
jest.mock('../../src/services/twilioSmsService.js',()=>({sendSms:jest.fn()}));
beforeAll(connectTestDB,60000);afterEach(async()=>{jest.restoreAllMocks();await clearTestDB();});afterAll(closeTestDB);
async function fixture(){
 const business=await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Synthetic Plumbing',businessType:'plumbing',phone:'+14045550121'});
 const service=await ServiceOffering.create({business:business._id,name:'Inspection',nameKey:'inspection'});
 const conversation=await Conversation.create({business:business._id,customerPhone:'+14045550123'});
 const appointment=await Appointment.create({business:business._id,serviceOffering:service._id,conversation:conversation._id,
 idempotencyKey: "synthetic-appointment",customerPhone:'+14045550123',status:'confirmed',startAt:new Date(Date.now()+86400000),endAt:new Date(Date.now()+90000000)});
 const job=await Job.create({business:business._id,appointment:appointment._id,key:'change_notice:business_approval_confirmed',
 type:'change_notice',body:'Synthetic confirmation',scheduledFor:new Date(0)});return{business,appointment,job};
}
test('a notification losing its claim during provider acceptance cannot overwrite the newer cancellation',async()=>{
 const{job}=await fixture();sendSms.mockImplementation(async()=>{
  await Job.updateOne({_id:job._id},{$set:{status:'canceled',claimToken:'replacement',failureReason:'Newer staff decision'}});
  return{sid:'SMsynthetic',status:'queued'};
 });
 await processNextAppointmentNotification();const stored=await Job.findById(job._id);
 expect(stored).toMatchObject({status:'canceled',claimToken:'replacement',failureReason:'Newer staff decision',providerMessageId:''});
});
test('an appointment revision changed before dispatch suppresses the notification',async()=>{
 const{appointment,job}=await fixture();sendSms.mockClear();const exists=Appointment.exists.bind(Appointment);
 jest.spyOn(Appointment,'exists').mockImplementationOnce(async filter=>{
  await Appointment.updateOne({_id:appointment._id},{$set:{status:'canceled',updatedAt:new Date(Date.now()+1000)}},{timestamps:false});return exists(filter);
 });
 await processNextAppointmentNotification();expect(sendSms).not.toHaveBeenCalled();expect((await Job.findById(job._id)).status).toBe('canceled');
});
test('a historical notification tuple cannot dispatch another business appointment',async()=>{
 const{job}=await fixture();const foreign=await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Foreign Plumbing',businessType:'plumbing',phone:'+14045550124'});
 await Job.collection.updateOne({_id:job._id},{$set:{business:foreign._id}});sendSms.mockClear();
 await processNextAppointmentNotification();expect(sendSms).not.toHaveBeenCalled();expect((await Job.findById(job._id)).status).toBe('canceled');
});
