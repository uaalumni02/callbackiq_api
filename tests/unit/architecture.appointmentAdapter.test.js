import { createAppointmentLookup } from '../../src/services/scheduling/appointmentLookup.adapter.js';
import { createExactSlotAvailability } from '../../src/services/scheduling/appointmentAvailability.adapter.js';

test('lookup always filters by tenant and returns the same found document', async () => {
 const appointment = {_id:'appt',business:'tenant'};
 const Appointment={findOne:jest.fn().mockResolvedValue(appointment)};
 const lookup=createAppointmentLookup({Appointment});
 expect(await lookup('tenant','appt')).toBe(appointment);
 expect(Appointment.findOne).toHaveBeenCalledWith({_id:'appt',business:'tenant'});
});
test('missing appointment retains original 404 error', async () => {
 const lookup=createAppointmentLookup({Appointment:{findOne:jest.fn().mockResolvedValue(null)}});
 await expect(lookup('tenant','missing')).rejects.toMatchObject({statusCode:404,message:'Appointment not found.'});
});
test('availability recheck matches exact start/end and honors tenant policy', async () => {
 const slot={startAt:'2026-11-02T16:00:00.000Z',endAt:'2026-11-02T17:00:00.000Z'};
 const getAvailability=jest.fn().mockResolvedValue({slots:[slot]});
 const withStaffSchedulingException=jest.fn(async (_,lookup)=>lookup());
 const available=createExactSlotAvailability({AvailabilityService:{getAvailability},withStaffSchedulingException,formatDateKey:()=> '2026-11-02'});
 const input={business:{_id:'tenant',timezone:'America/New_York'},serviceOfferingId:'service',startAt:slot.startAt,endAt:slot.endAt,postalCode:'30324'};
 expect(await available(input)).toBe(true);
 expect(getAvailability).toHaveBeenCalledWith(expect.objectContaining({business:input.business,serviceOfferingId:'service',startDate:'2026-11-02',endDate:'2026-11-02',postalCode:'30324'}));
 expect(withStaffSchedulingException).not.toHaveBeenCalled();
 expect(await available({...input,approvedExistingRequest:true})).toBe(true);
 expect(withStaffSchedulingException).toHaveBeenCalledTimes(1);
 getAvailability.mockResolvedValue({slots:[]});
 expect(await available(input)).toBe(false);
});
test('provider rejection propagates instead of claiming no availability', async () => {
 const fail=Object.assign(new Error('provider offline'),{code:'PROVIDER_OFFLINE'});
 const available=createExactSlotAvailability({AvailabilityService:{getAvailability:jest.fn().mockRejectedValue(fail)},withStaffSchedulingException:jest.fn(),formatDateKey:()=> '2026-11-02'});
 await expect(available({business:{_id:'tenant'},serviceOfferingId:'service',startAt:'2026-11-02T16:00:00Z',endAt:'2026-11-02T17:00:00Z'})).rejects.toBe(fail);
});
