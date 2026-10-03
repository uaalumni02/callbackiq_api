import { normalizeAppointmentAddress } from '../../src/services/scheduling/appointmentAddress.service.js';
import AppointmentService from '../../src/services/scheduling/appointment.service.js';
test.each(['123 Peachtree St, Atlanta, GA 30303',null,[],false,42,{postalCode:{value:'30303'}},{street:['123 Street']}])('malformed address produces input error before database/provider work: %p',async address=>{
 expect(()=>normalizeAppointmentAddress(address)).toThrow(/address must be an object/);
 await expect(AppointmentService.create({business:{},input:{customerPhone:'+16785768258',address}})).rejects.toMatchObject({statusCode:400,code:'INVALID_APPOINTMENT_ADDRESS'});
 await expect(AppointmentService.reschedule({business:{},input:{address}})).rejects.toMatchObject({statusCode:400});
 await expect(AppointmentService.update({changes:{address}})).rejects.toMatchObject({statusCode:400});
});
test('structured address retains its ZIP for real coverage checks',()=>{
 expect(normalizeAppointmentAddress({street:' 123 Peachtree St ',city:' Atlanta ',state:' GA ',postalCode:' 30303 '})).toEqual({street:'123 Peachtree St',city:'Atlanta',state:'GA',postalCode:'30303'});
});
test('optional or partial address still defers required fields to policy',()=>{
 expect(normalizeAppointmentAddress()).toEqual({street:'',city:'',state:'',postalCode:''});
 expect(normalizeAppointmentAddress({postalCode:'30303'}).postalCode).toBe('30303');
});
