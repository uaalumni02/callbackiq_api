import AppointmentNotificationJob from '../../src/models/appointmentNotificationJob.js';
import { scheduleAppointmentChangeNotice } from '../../src/services/scheduling/appointmentNotification.service.js';
jest.mock('../../src/models/appointmentNotificationJob.js', () => ({__esModule:true,default:{findOneAndUpdate:jest.fn()}}));
test('business approval retry preserves sent notice and provider receipt',async()=>{
 let stored=null;
 AppointmentNotificationJob.findOneAndUpdate.mockImplementation(async(filter,update)=>{
   if (!stored) stored={...filter,...update.$setOnInsert,...update.$set};
   else Object.assign(stored,update.$set);
   return stored;
 });
 const appointment={_id:'appointment',business:'business',lead:'lead',conversation:'conversation'};
 await scheduleAppointmentChangeNotice({appointment,key:'business_approval_confirmed',body:'Confirmed'});
 stored.status='sent';stored.providerMessageId='SMalreadyaccepted';stored.attempts=1;
 const replay=await scheduleAppointmentChangeNotice({appointment,key:'business_approval_confirmed',body:'Confirmed'});
 expect(replay).toMatchObject({status:'sent',providerMessageId:'SMalreadyaccepted',attempts:1});
 expect(AppointmentNotificationJob.findOneAndUpdate.mock.calls[1][0]).toEqual({business:'business',appointment:'appointment',key:'change_notice:business_approval_confirmed'});
});
