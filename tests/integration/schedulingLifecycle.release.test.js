import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import Appointment from '../../src/models/appointment.js';
import Alert from '../../src/models/alert.js';
import Notice from '../../src/models/appointmentNotificationJob.js';
import Rule from '../../src/models/availabilityRule.js';
import Exception from '../../src/models/availabilityException.js';
import Policy from '../../src/models/schedulingPolicy.js';
import Service from '../../src/models/serviceOffering.js';
import Area from '../../src/models/serviceArea.js';
import NotificationJob from '../../src/models/staffNotificationJob.js';
import AppointmentService from '../../src/services/scheduling/appointment.service.js';
import AvailabilityService from '../../src/services/scheduling/availability.service.js';
import VoiceAvailability from '../../src/voice/voiceAvailability.service.js';
import { reconcileApprovalRequests, ensureApprovalReview } from '../../src/services/scheduling/approvalLifecycle.service.js';
import { handleAppointmentReply } from '../../src/services/scheduling/appointmentReply.service.js';
import { runStaffNotificationsOnce } from '../../src/services/staffNotification.service.js';
import { runStaffSchedulingRequest } from '../../src/services/scheduling/staffSchedulingException.service.js';
import { shiftDate } from '../../src/services/scheduling/availabilityWindows.service.js';
let mongo,business,service,owner,date,input;
const oldFlag=process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;
beforeAll(async()=>{
 mongo=await MongoMemoryServer.create({binary:{version:'7.0.24'}});await mongoose.connect(mongo.getUri());
 await Promise.all([Appointment.init(),Alert.init(),Notice.init(),Rule.init(),Policy.init(),NotificationJob.init()]);
},120000);
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();if(oldFlag===undefined)delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;else process.env.STAFF_NOTIFICATION_EMAIL_ENABLED=oldFlag;});
beforeEach(async()=>{
 for(const collection of Object.values(mongoose.connection.collections))await collection.deleteMany({});
 owner=new mongoose.Types.ObjectId();
 await User.collection.insertOne({_id:owner,email:'owner@example.com',emailVerifiedAt:new Date()});
 business=await Business.create({owner,businessName:'Test Plumbing',businessType:'plumbing',phone:'+14045550101',forwardingPhone:'+14045550102',timezone:'UTC',isActive:true});
 service=await Service.create({business:business._id,name:'Diagnostic visit',durationMinutes:60,aiCanBook:true,active:true});
 await Area.create({business:business._id,type:'unrestricted'});
 await Policy.create({business:business._id,minimumNoticeMinutes:0,allowSameDayBooking:true});
 await Rule.insertMany(Array.from({length:7},(_,dayOfWeek)=>({business:business._id,dayOfWeek,enabled:true,windows:[{startTime:'09:00',endTime:'17:00'}],timezone:'UTC',capacity:1})));
 date=shiftDate(new Date().toISOString().slice(0,10),2);
 input={serviceOfferingId:service._id,customerPhone:'+14045550199',customerName:'Sarah',address:{street:'125 Main Street',postalCode:'30303'},startAt:`${date}T10:00:00Z`,endAt:`${date}T11:00:00Z`,bookedBy:'staff',source:'manual',requiresBusinessApproval:true,holdMinutes:30};
});
const create=()=>AppointmentService.create({business,input,idempotencyKey:'request-1',confirm:false});
const available=()=>AvailabilityService.getAvailability({business,serviceOfferingId:service._id,startDate:date,endDate:date,postalCode:'30303'});

test('medium approval gets an owner, deadline, mobile email link and one notification job',async()=>{
 const appointment=await create();await ensureApprovalReview(appointment);await ensureApprovalReview(appointment);
 const alert=await Alert.findOne({'metadata.approvalRequest':true});
 expect(alert.actionRequired).toBe(true);expect(alert.priority).toBe('medium');expect(String(alert.assignedTo)).toBe(String(owner));expect(alert.dueAt).toBeTruthy();
 process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';const send=jest.fn().mockResolvedValue({accepted:['owner@example.com'],messageId:'email-1'});
 await runStaffNotificationsOnce({send});await runStaffNotificationsOnce({send});
 expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].appointmentId).toBe(String(appointment._id));
 expect(await NotificationJob.countDocuments()).toBe(1);
});
test('expiry releases capacity, keeps actionable request and queues a single honest customer notice',async()=>{
 const appointment=await create();await Appointment.updateOne({_id:appointment._id},{$set:{heldExpiresAt:new Date(Date.now()-1000)}});
 await AppointmentService.releaseExpiredHolds();await AppointmentService.releaseExpiredHolds();
 const expired=await Appointment.findById(appointment._id);
 expect(expired.status).toBe('failed');expect(expired.slotClaimKeys).toHaveLength(0);expect(expired.approvalRecovery.state).toBe('needs_recheck');
 expect(await Alert.countDocuments({'metadata.approvalRequest':true,actionRequired:true})).toBe(1);
 expect(await Notice.countDocuments({key:'change_notice:approval_hold_expired'})).toBe(1);
 expect((await Notice.findOne()).body).not.toMatch(/shortly|will call|confirmed for/);
 expect((await available()).slots.some(s=>Date.parse(s.startAt)===Date.parse(input.startAt))).toBe(true);
});
test('interrupted expiry reconciliation is retried without duplicate notices',async()=>{
 const appointment=await create();await Appointment.updateOne({_id:appointment._id},{$set:{status:'failed',failureReason:'The appointment hold expired.',slotClaimKeys:[],activeSlotKey:null,'approvalRecovery.expiredAt':new Date()}});
 const spy=jest.spyOn(Alert,'findOneAndUpdate').mockRejectedValueOnce(new Error('temporary database issue'));
 await reconcileApprovalRequests();expect((await Appointment.findById(appointment._id)).approvalRecovery.reconciled).not.toBe(true);spy.mockRestore();
 await reconcileApprovalRequests();expect(await Notice.countDocuments()).toBe(1);
});
test('expired approval rechecks, reclaims, confirms and is safe to retry',async()=>{
 const appointment=await create();await Appointment.updateOne({_id:appointment._id},{$set:{heldExpiresAt:new Date(Date.now()-1000)}});await AppointmentService.releaseExpiredHolds();
 const confirmed=await AppointmentService.recheckAndConfirm({business,appointmentId:appointment._id,approvedBy:owner});
 expect(confirmed.status).toBe('confirmed');expect(confirmed.slotClaimKeys.length).toBeGreaterThan(0);
 const replay=await AppointmentService.recheckAndConfirm({business,appointmentId:appointment._id,approvedBy:owner});expect(String(replay._id)).toBe(String(appointment._id));
 expect(await Notice.countDocuments({key:'change_notice:business_approval_confirmed'})).toBe(1);
});
test('expired request cannot steal a slot taken by another customer or cross business scope',async()=>{
 const appointment=await create();await Appointment.updateOne({_id:appointment._id},{$set:{heldExpiresAt:new Date(Date.now()-1000)}});await AppointmentService.releaseExpiredHolds();
 await AppointmentService.create({business,input:{...input,customerPhone:'+14045550198'},idempotencyKey:'other-customer',confirm:false});
 await expect(AppointmentService.recheckAndConfirm({business,appointmentId:appointment._id,approvedBy:owner})).rejects.toMatchObject({code:'SLOT_UNAVAILABLE'});
 await expect(AppointmentService.recheckAndConfirm({business:{...business.toObject(),_id:new mongoose.Types.ObjectId()},appointmentId:appointment._id,approvedBy:owner})).rejects.toThrow();
});
test('partial closure removes only overlapping jobs; answering-only changes do not affect slots',async()=>{
 await Exception.create({business:business._id,date,type:'closure',allDay:false,windows:[{startTime:'12:00',endTime:'13:00'}]});
 const slots=(await available()).slots;expect(slots.some(s=>s.startAt.includes('09:00'))).toBe(true);expect(slots.some(s=>s.startAt.includes('12:00'))).toBe(false);expect(slots.some(s=>s.startAt.includes('14:00'))).toBe(true);
 await Exception.create({business:business._id,date,type:'closure',allDay:true,appliesTo:'answering'});
 expect((await available()).slots).toHaveLength(slots.length);
});
test('fully booked does not close the office; explicit answering hours and future holidays are respected',async()=>{
 await Exception.create({business:business._id,date,type:'fully_booked',allDay:true});
 expect(await VoiceAvailability.isBusinessOpen(business,new Date(`${date}T10:00:00Z`))).toBe(true);expect((await available()).slots).toHaveLength(0);
 await Rule.updateMany({business:business._id},{$set:{separateAnsweringHours:true,answeringEnabled:true,answeringWindows:[{startTime:'07:00',endTime:'19:00'}]}});
 expect(await VoiceAvailability.isBusinessOpen(business,new Date(`${date}T18:00:00Z`))).toBe(true);
 await Exception.create({business:business._id,date:shiftDate(date,1),type:'closure',allDay:true});
 const reply=await VoiceAvailability.describeBusinessHours(business,new Date(`${date}T20:00:00Z`));expect(reply).not.toMatch(/tomorrow/);
});
test('overnight hours create appointments on both sides of midnight',async()=>{
 await Rule.updateMany({business:business._id},{$set:{windows:[{startTime:'22:00',endTime:'02:00'}]}});
 const slots=(await available()).slots;expect(slots.some(s=>s.startAt.includes('00:00'))).toBe(true);expect(slots.some(s=>s.startAt.includes('23:30'))).toBe(true);
});
test('arrival window preserves internal duration and exact-mode defaults',async()=>{
 expect((await available()).slots[0].arrivalStartAt).toBeUndefined();
 await Policy.updateOne({business:business._id},{$set:{appointmentStyle:'arrival_window',arrivalWindowMinutes:120}});
 const appointment=await create();expect(appointment.arrivalStartAt).toEqual(new Date(`${date}T10:00:00Z`));expect(appointment.arrivalEndAt).toEqual(new Date(`${date}T12:00:00Z`));expect(appointment.endAt-appointment.startAt).toBe(3600000);
});
test('short-notice staff capability is scoped and cannot override a closure',async()=>{
 await Policy.updateOne({business:business._id},{$set:{minimumNoticeMinutes:10080}});
 expect((await available()).slots).toHaveLength(0);
 const context={business,userId:owner,preview:true,input:{serviceOfferingId:service._id,schedulingException:{allowShortNotice:true,reason:'Customer agreed and technician is available.'}}};
 expect((await runStaffSchedulingRequest(context,available)).slots.length).toBeGreaterThan(0);
 expect((await available()).slots).toHaveLength(0);
 await Exception.create({business:business._id,date,type:'closure',allDay:true});
 expect((await runStaffSchedulingRequest(context,available)).slots).toHaveLength(0);
});
test.each(['C','R'])('reminder reply %s works during human takeover without enabling AI',async text=>{
 const appointment=await create();await Appointment.updateOne({_id:appointment._id},{$set:{status:'confirmed'}});
 await Notice.create({business:business._id,appointment:appointment._id,key:'reminder:24',type:'reminder',scheduledFor:new Date(),status:'sent',sentAt:new Date()});
 const conversation={_id:new mongoose.Types.ObjectId(),customerPhone:input.customerPhone,humanTakeover:true,aiEnabled:false};
 const inboundMessage={_id:new mongoose.Types.ObjectId()};
 const result=await handleAppointmentReply({business,conversation,inboundMessage,text});expect(result.handled).toBe(true);
 expect((await Appointment.findById(appointment._id)).status).toBe('confirmed');expect(conversation.humanTakeover).toBe(true);
 await handleAppointmentReply({business,conversation,inboundMessage,text});expect(await Notice.countDocuments({key:`change_notice:reply_${inboundMessage._id}`})).toBe(1);
});
