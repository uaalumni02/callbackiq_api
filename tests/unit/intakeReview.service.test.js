import VoiceSession from '../../src/models/voiceSession.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import Alert from '../../src/models/alert.js';
import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import AppointmentService, { ensureBusinessApprovalNotice } from '../../src/services/scheduling/appointment.service.js';
import { withDistributedLease } from '../../src/services/distributedLease.service.js';
import { approveIntake, intakeReviewVersion } from '../../src/services/booking/intakeReview.service.js';
jest.mock('../../src/models/voiceSession.js', () => ({ __esModule:true, default:{exists:jest.fn()} }));
jest.mock('../../src/models/conversation.js', () => ({ __esModule:true, default:{findOne:jest.fn(),updateOne:jest.fn()} }));
jest.mock('../../src/models/lead.js', () => ({ __esModule:true, default:{findOne:jest.fn()} }));
jest.mock('../../src/models/alert.js', () => ({ __esModule:true, default:{exists:jest.fn()} }));
jest.mock('../../src/models/appointmentNotificationJob.js', () => ({ __esModule:true, default:{findOne:jest.fn()} }));
jest.mock('../../src/services/scheduling/appointment.service.js', () => ({ __esModule:true, default:{create:jest.fn(),confirm:jest.fn()},ensureBusinessApprovalNotice:jest.fn() }));
jest.mock('../../src/services/distributedLease.service.js', () => ({ withDistributedLease:jest.fn(),assertDistributedLeaseActive:jest.fn() }));
const business={_id:'a'.repeat(24),timezone:'America/New_York'};
let conversation,lead,input,appointment;
beforeEach(()=>{
 jest.clearAllMocks();
 VoiceSession.exists.mockResolvedValue(null);
 conversation={_id:'b'.repeat(24),lead:'c'.repeat(24),status:'open',customerPhone:'+14045550123',orchestration:{recoveryJourneyKey:'journey'},conversationMemory:{recoveryIntake:{submitted:true}}};
 lead={_id:conversation.lead,serviceNeeded:'Bathtub resealing',address:'970 Sidney Marcus Blvd NE Atlanta GA 30324',preferredAppointmentTime:'2026-09-09 at 08:00'};
 input={serviceOfferingId:'d'.repeat(24),startAt:'2026-09-09T12:00:00.000Z',intakeReviewVersion:intakeReviewVersion(conversation,lead)};
 appointment={_id:'e'.repeat(24),customerPhone:conversation.customerPhone,conversation:conversation._id,lead:lead._id,address:{street:lead.address,postalCode:'30324'},serviceOffering:input.serviceOfferingId,startAt:new Date(input.startAt),status:'confirmed',requiresBusinessApproval:true};
 Conversation.findOne.mockResolvedValue(conversation); Lead.findOne.mockResolvedValue(lead);Alert.exists.mockResolvedValue({_id:'alert'});
 withDistributedLease.mockImplementation(async(key,fn)=>({acquired:true,value:await fn()}));
 AppointmentService.create.mockResolvedValue(appointment);AppointmentService.confirm.mockResolvedValue(appointment);
 AppointmentNotificationJob.findOne.mockReturnValue({lean:jest.fn().mockResolvedValue({status:'scheduled'})});
 ensureBusinessApprovalNotice.mockResolvedValue({});
});
const run=()=>approveIntake({business,conversationId:conversation._id,input,approvedBy:'owner'});
test('staff approval uses durable customer details and existing approval engine with fixed replay key',async()=>{
 input.customerPhone='+19999999999';input.requiresBusinessApproval=false;input.idempotencyKey='browser-random';
 expect((await run()).confirmationNoticeStatus).toBe('scheduled'); await run();
 expect(AppointmentService.create.mock.calls[0][0]).toMatchObject({confirm:false,input:{customerPhone:conversation.customerPhone,requiresBusinessApproval:true,bookedBy:'staff',lead:lead._id,address:{street:lead.address,postalCode:'30324'}}});
 expect(AppointmentService.create.mock.calls[0][0].idempotencyKey).toBe(AppointmentService.create.mock.calls[1][0].idempotencyKey);
 expect(AppointmentService.confirm).toHaveBeenCalledWith({business,appointmentId:appointment._id,approvedBy:'owner'});
});
test('rejects stale review before appointment creation',async()=>{lead.address='123 Other St Atlanta GA 30324';await expect(run()).rejects.toMatchObject({code:'INTAKE_REVIEW_CHANGED'});expect(AppointmentService.create).not.toHaveBeenCalled();});
test('rejects cross-business/missing conversation',async()=>{Conversation.findOne.mockResolvedValue(null);await expect(run()).rejects.toMatchObject({statusCode:404});expect(Conversation.findOne).toHaveBeenCalledWith({_id:conversation._id,business:business._id});});
test('rejects active SMS update conflict',async()=>{withDistributedLease.mockResolvedValue({acquired:false});await expect(run()).rejects.toMatchObject({code:'INTAKE_BUSY'});expect(AppointmentService.create).not.toHaveBeenCalled();});
test.each(['closed','archived'])('rejects %s conversation',async(status)=>{conversation.status=status;await expect(run()).rejects.toMatchObject({code:'INTAKE_NOT_REVIEWABLE'});});
test('requires actual durable handoff alert',async()=>{Alert.exists.mockResolvedValue(null);await expect(run()).rejects.toMatchObject({code:'INTAKE_REVIEW_MISSING'});expect(AppointmentService.create).not.toHaveBeenCalled();});
test('does not confirm mismatched replay selection',async()=>{appointment.startAt=new Date('2026-09-09T13:00:00Z');await expect(run()).rejects.toMatchObject({code:'INTAKE_APPOINTMENT_MISMATCH'});expect(AppointmentService.confirm).not.toHaveBeenCalled();});
test('reports missing notice honestly after confirmed booking',async()=>{ensureBusinessApprovalNotice.mockRejectedValue(new Error('database unavailable'));expect(await run()).toMatchObject({appointment:{status:'confirmed'},confirmationNoticeStatus:'unavailable'});});
test('rejects ambiguous timezone and invalid selection',async()=>{input.startAt='2026-09-09T08:00';await expect(run()).rejects.toMatchObject({statusCode:400});expect(withDistributedLease).not.toHaveBeenCalled();});

test('does not reuse a prior appointment with a different reviewed address',async()=>{appointment.address.street='123 Different St';await expect(run()).rejects.toMatchObject({code:'INTAKE_APPOINTMENT_MISMATCH'});expect(AppointmentService.confirm).not.toHaveBeenCalled();});
test('does not treat uncertain fallback as completed intake',async()=>{conversation.conversationMemory.recoveryIntake.failures=2;await expect(run()).rejects.toMatchObject({code:'INTAKE_NOT_REVIEWABLE'});});
test('does not approve stale journey submission',async()=>{conversation.conversationMemory.recoveryIntake.journeyKey='previous';await expect(run()).rejects.toMatchObject({code:'INTAKE_NOT_REVIEWABLE'});});

test('approves completed voice intake without SMS handoff state and preserves notification evidence', async()=>{
 conversation.conversationMemory.recoveryIntake={submitted:true,reviewReady:true,journeyKey:'journey',triageAnswer:'Only when I use the bathtub'};
 input.intakeReviewVersion=intakeReviewVersion(conversation,lead);
 expect((await run()).appointment.status).toBe('confirmed');
 expect(VoiceSession.exists).toHaveBeenCalledWith(expect.objectContaining({business:business._id,conversation:conversation._id}));
});
test('does not approve while voice caller is still supplying facts',async()=>{
 VoiceSession.exists.mockResolvedValue({_id:'active-call'});
 await expect(run()).rejects.toMatchObject({code:'INTAKE_VOICE_ACTIVE'});
 expect(AppointmentService.create).not.toHaveBeenCalled();
});
test('does not confirm when voice triage facts change during availability lookup',async()=>{
 AppointmentService.create.mockImplementation(async()=>{conversation.conversationMemory.recoveryIntake.triageAnswer='Now leaking constantly';return appointment;});
 await expect(run()).rejects.toMatchObject({code:'INTAKE_REVIEW_CHANGED'});
 expect(AppointmentService.confirm).not.toHaveBeenCalled();
});
test('does not confirm if a voice call starts during hold creation',async()=>{
 VoiceSession.exists.mockResolvedValueOnce(null).mockResolvedValueOnce({_id:'new-call'});
 await expect(run()).rejects.toMatchObject({code:'INTAKE_VOICE_ACTIVE'});
 expect(AppointmentService.confirm).not.toHaveBeenCalled();
});

test('does not create appointment for anonymous voice contact',async()=>{conversation.customerPhone='+00000000000';input.intakeReviewVersion=intakeReviewVersion(conversation,lead);await expect(run()).rejects.toMatchObject({code:'INTAKE_CONTACT_REQUIRED'});expect(AppointmentService.create).not.toHaveBeenCalled();});
test('preserves discoverable hold when provider confirmation fails',async()=>{AppointmentService.confirm.mockRejectedValue(new Error('provider unavailable'));await expect(run()).rejects.toThrow('provider unavailable');expect(Conversation.updateOne).toHaveBeenCalledWith(expect.anything(),{$set:expect.objectContaining({'conversationMemory.recoveryIntake.reviewAppointmentId':appointment._id})});});

test('customer contact correction invalidates reviewed version',async()=>{conversation.customerPhone='+14045550124';await expect(run()).rejects.toMatchObject({code:'INTAKE_REVIEW_CHANGED'});expect(AppointmentService.create).not.toHaveBeenCalled();});

test('new scheduling-review request is eligible for staff approval',async()=>{
 conversation.conversationMemory.recoveryIntake={};conversation.orchestration.handoffReason='scheduling_review';
 input.intakeReviewVersion=intakeReviewVersion(conversation,lead);
 expect((await run()).appointment.status).toBe('confirmed');
});
test('withdrawal invalidates a scheduling review even if its handoff reason remains',async()=>{
 conversation.conversationMemory.recoveryIntake={withdrawnAt:new Date()};conversation.orchestration.handoffReason='scheduling_review';
 input.intakeReviewVersion=intakeReviewVersion(conversation,lead);
 await expect(run()).rejects.toMatchObject({code:'INTAKE_NOT_REVIEWABLE'});
});
test('staff exception exists only inside the reviewed create and confirm operations',async()=>{
 const {currentStaffSchedulingException}=require('../../src/services/scheduling/staffSchedulingException.service.js');
 input.schedulingException={allowShortNotice:true,reason:'Customer and dispatcher agreed on this earlier appointment.'};
 const scope={businessId:business._id,serviceOfferingId:input.serviceOfferingId,startAt:input.startAt};
 AppointmentService.create.mockImplementation(async()=>{expect(currentStaffSchedulingException(scope)).toMatchObject({approvedBy:'f'.repeat(24),reason:input.schedulingException.reason});return appointment;});
 AppointmentService.confirm.mockImplementation(async()=>{expect(currentStaffSchedulingException(scope)).toBeTruthy();return appointment;});
 await approveIntake({business,conversationId:conversation._id,input,approvedBy:'f'.repeat(24)});
 expect(currentStaffSchedulingException(scope)).toBeNull();
});
test.each([{}, {allowShortNotice:true}, {allowShortNotice:false,reason:'Long enough documented reason.'}, {allowShortNotice:true,reason:'short'}])('rejects incomplete scheduling exception %j',async exception=>{
 input.schedulingException=exception;await expect(run()).rejects.toMatchObject({code:'INVALID_SCHEDULING_EXCEPTION'});
 expect(AppointmentService.create).not.toHaveBeenCalled();
});
test('scheduling review cannot create a second appointment for an already booked request',async()=>{
 conversation.bookingState={status:'booked',appointment:'existing'};
 conversation.orchestration.handoffReason='scheduling_review';input.intakeReviewVersion=intakeReviewVersion(conversation,lead);
 await expect(run()).rejects.toMatchObject({code:'INTAKE_EXISTING_APPOINTMENT'});expect(AppointmentService.create).not.toHaveBeenCalled();
});
