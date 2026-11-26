// SMS dispatch/claim assertions run against a replica set in integration/approvalDelivery.pilot.test.js.
import Appointment from '../../src/models/appointment.js';
import Notice from '../../src/models/appointmentNotificationJob.js';
import AlertService from '../../src/services/alert.service.js';
import {handleAppointmentReply} from '../../src/services/scheduling/appointmentReply.service.js';
import {scheduleAppointmentChangeNotice} from '../../src/services/scheduling/appointmentNotification.service.js';
jest.mock('../../src/models/appointment.js',()=>({__esModule:true,default:{find:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/models/appointmentNotificationJob.js',()=>({__esModule:true,default:{exists:jest.fn()}}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{create:jest.fn()}}));
jest.mock('../../src/services/twilioSmsService.js',()=>({sendSms:jest.fn()}));
jest.mock('../../src/services/scheduling/appointmentNotification.service.js',()=>({scheduleAppointmentChangeNotice:jest.fn()}));
const chain=value=>({sort:()=>({limit:()=>({lean:async()=>value})})});
beforeEach(()=>jest.clearAllMocks());
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
