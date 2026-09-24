import Alert from '../../src/models/alert.js';
import Business from '../../src/models/business.js';
import Policy from '../../src/models/schedulingPolicy.js';
import Appointment from '../../src/models/appointment.js';
import Notice from '../../src/models/appointmentNotificationJob.js';
import AlertService from '../../src/services/alert.service.js';
import { runApprovalSms } from '../../src/services/scheduling/approvalSms.service.js';
import { handleAppointmentReply } from '../../src/services/scheduling/appointmentReply.service.js';
import { scheduleAppointmentChangeNotice } from '../../src/services/scheduling/appointmentNotification.service.js';
jest.mock('../../src/models/alert.js',()=>({__esModule:true,default:{find:jest.fn(),findOneAndUpdate:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/models/business.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/models/schedulingPolicy.js',()=>({__esModule:true,default:{find:jest.fn()}}));
jest.mock('../../src/models/appointment.js',()=>({__esModule:true,default:{find:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/models/appointmentNotificationJob.js',()=>({__esModule:true,default:{exists:jest.fn()}}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{create:jest.fn()}}));
jest.mock('../../src/services/twilioSmsService.js',()=>({sendSms:jest.fn()}));
jest.mock('../../src/services/scheduling/appointmentNotification.service.js',()=>({scheduleAppointmentChangeNotice:jest.fn()}));
const chain = value=>({sort:()=>({limit:()=>({lean:async()=>value})})});
let send,alert,now;
const savedEnv={...process.env};
beforeEach(()=>{
 jest.clearAllMocks(); process.env.STAFF_APPROVAL_SMS_ENABLED='true';process.env.CLIENT_URL='https://app.example.com';
 now=new Date('2026-09-24T12:00:00Z');
 alert={_id:'alert1',business:'b1',appointment:'a1',dueAt:new Date('2026-09-24T13:00:00Z'),metadata:{approvalRequest:true,approvalState:'pending'}};
 Policy.find.mockReturnValue({lean:async()=>[{business:'b1',approvalSmsEnabled:true,approvalSmsPhone:'+14045550101'}]});
 Alert.find.mockImplementation(()=>chain([alert]));Business.findOne.mockResolvedValue({_id:'b1',isActive:true});
 Alert.findOneAndUpdate.mockResolvedValue(alert);Alert.updateOne.mockResolvedValue({modifiedCount:1});send=jest.fn().mockResolvedValue({sid:'SM-test'});
});
afterAll(()=>{process.env=savedEnv;});
test('staff SMS is globally off unless deliberately enabled',async()=>{
 delete process.env.STAFF_APPROVAL_SMS_ENABLED;expect(await runApprovalSms({send,now})).toEqual({disabled:true});expect(Policy.find).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
});
test('approval text uses an authenticated request link, explicit staff source and stable identity',async()=>{
 expect(await runApprovalSms({send,now})).toEqual({sent:1});
 expect(send).toHaveBeenCalledWith(expect.objectContaining({to:'+14045550101',source:'staff_approval_notice',body:expect.stringContaining('/appointments?appointmentId=a1'),metadata:{idempotencyKey:'staff-approval:alert1:initial'}}));
 expect(send.mock.calls[0][0].body).not.toMatch(/125 Main|Sarah|reply 1/i);
});
test('an atomic claim prevents a concurrent sender duplicating a text',async()=>{
 Alert.findOneAndUpdate.mockResolvedValue(null);await runApprovalSms({send,now});expect(send).not.toHaveBeenCalled();
});
test('a delivered stage is not sent twice',async()=>{
 alert.metadata.approvalSms={initial:{state:'sent',at:now}};await runApprovalSms({send,now});expect(send).not.toHaveBeenCalled();
});
test('safe quiet-hours suppression schedules a retry, provider uncertainty does not',async()=>{
 send.mockResolvedValue({suppressed:true,reason:'outside_send_window'});await runApprovalSms({send,now});
 expect(Alert.updateOne.mock.calls[0][1].$set['metadata.approvalSms.initial']).toMatchObject({state:'blocked',retryAt:new Date(now.getTime()+900000)});
 jest.clearAllMocks();alert.metadata.approvalSms={initial:{state:'sending',at:new Date(now.getTime()-180000)}};
 await runApprovalSms({send,now});expect(send).not.toHaveBeenCalled();expect(Alert.updateOne.mock.calls[0][1].$set['metadata.approvalSms.initial.state']).toBe('uncertain');
});
test('expiry notification does not claim the appointment is still reserved',async()=>{
 alert.metadata.approvalState='needs_recheck';await runApprovalSms({send,now});expect(send.mock.calls[0][0].body).toContain('reservation expired');
 expect(send.mock.calls[0][0].metadata.idempotencyKey).toBe('staff-approval:alert1:expired');
});
const customerReply=text=>handleAppointmentReply({business:{_id:'b1',isActive:true},conversation:{_id:'c1',customerPhone:'+14045550199',aiEnabled:false,humanTakeover:true},inboundMessage:{_id:'m1'},text});
test.each(['C','R'])('reminder %s works independently of AI state and does not cancel the booking',async text=>{
 Appointment.find.mockReturnValue(chain([{_id:'a1',business:'b1',customerPhone:'+14045550199',status:'confirmed',startAt:'2026-10-01T10:00:00Z',timezone:'UTC'}]));
 Appointment.updateOne.mockResolvedValue({matchedCount:1});Notice.exists.mockResolvedValue({_id:'n1'});
 expect(await customerReply(text)).toMatchObject({handled:true});
 expect(Appointment.updateOne.mock.calls[0][0]).toMatchObject({business:'b1',status:'confirmed'});
 expect(Appointment.updateOne.mock.calls[0][1].$set).not.toHaveProperty('status');
 expect(scheduleAppointmentChangeNotice).toHaveBeenCalledWith(expect.objectContaining({key:'reply_m1'}));
 if(text==='R')expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({actionRequired:true,priority:'high'}));
});
test('multiple appointments request clarification rather than choosing one',async()=>{
 Appointment.find.mockReturnValue(chain([{_id:'a1'},{_id:'a2'}]));expect(await customerReply('C')).toMatchObject({ambiguous:true});expect(Appointment.updateOne).not.toHaveBeenCalled();
});
test('bare controls without an earlier reminder are left to the existing conversation path',async()=>{
 Appointment.find.mockReturnValue(chain([{_id:'a1'}]));Notice.exists.mockResolvedValue(null);expect(await customerReply('R')).toBeNull();expect(scheduleAppointmentChangeNotice).not.toHaveBeenCalled();
});
