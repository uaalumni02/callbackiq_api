import { withStaffSchedulingException } from '../../src/services/scheduling/staffSchedulingException.service.js';
import { generateInternalSlots } from '../../src/services/scheduling/slotGenerator.service.js';
import AvailabilityService from '../../src/services/scheduling/availability.service.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import SchedulingPolicy from '../../src/models/schedulingPolicy.js';
import ServiceArea from '../../src/models/serviceArea.js';
import AvailabilityRule from '../../src/models/availabilityRule.js';
import AvailabilityException from '../../src/models/availabilityException.js';
import Appointment from '../../src/models/appointment.js';
import Factory from '../../src/services/scheduling/schedulingProviderFactory.js';
const lean=value=>({lean:async()=>value});
const business={_id:'b',timezone:'UTC'};
const startAt='2026-09-21T12:00:00.000Z';
const args={business,serviceOfferingId:'s',startDate:'2026-09-21',endDate:'2026-09-21',postalCode:'30324'};
const exception={businessId:'b',serviceOfferingId:'s',startAt,approvedBy:'staff',reason:'Reviewed earlier appointment.'};
beforeEach(()=>{
 jest.useFakeTimers();jest.setSystemTime(new Date('2026-09-21T10:00:00Z'));
 jest.spyOn(ServiceOffering,'findOne').mockReturnValue(lean({_id:'s',active:true,aiCanDiscuss:true,aiCanBook:true,durationMinutes:60}));
 jest.spyOn(SchedulingPolicy,'findOne').mockReturnValue(lean(null));
 jest.spyOn(ServiceArea,'findOne').mockReturnValue(lean({type:'zip_codes',zipCodes:['30324']}));
 jest.spyOn(AvailabilityRule,'find').mockReturnValue(lean([{dayOfWeek:1,enabled:true,capacity:1,windows:[{startTime:'12:00',endTime:'14:00'}]}]));
 jest.spyOn(AvailabilityException,'find').mockReturnValue(lean([]));
 jest.spyOn(Appointment,'find').mockReturnValue(lean([]));
 jest.spyOn(Factory,'getProvider').mockReturnValue({getAvailability:options=>generateInternalSlots({...options,business})});
});
afterEach(()=>{jest.restoreAllMocks();jest.useRealTimers();});
test('short-notice exception exposes only its exact reviewed slot and never leaks to concurrent ordinary availability',async()=>{
 const [staff,ordinary]=await Promise.all([withStaffSchedulingException(exception,()=>AvailabilityService.getAvailability(args)),AvailabilityService.getAvailability(args)]);
 expect(staff.slots.map(s=>new Date(s.startAt).toISOString())).toEqual([startAt]);expect(ordinary.slots).toEqual([]);
 expect((await AvailabilityService.getAvailability(args)).slots).toEqual([]);
});
test.each([{businessId:'other'}, {serviceOfferingId:'other'}, {startAt:'2026-09-21T18:00:00Z'}])('exception does not bypass scope or hours: %j',async changes=>{
 expect((await withStaffSchedulingException({...exception,...changes},()=>AvailabilityService.getAvailability(args))).slots).toEqual([]);
});
test('exception does not bypass capacity conflicts',async()=>{
 Appointment.find.mockReturnValue(lean([{startAt:new Date(startAt),endAt:new Date('2026-09-21T13:00:00Z'),status:'confirmed'}]));
 expect((await withStaffSchedulingException(exception,()=>AvailabilityService.getAvailability(args))).slots).toEqual([]);
});
test('exception does not create past slots',async()=>{
 jest.setSystemTime(new Date('2026-09-21T13:30:00Z'));
 expect((await withStaffSchedulingException(exception,()=>AvailabilityService.getAvailability(args))).slots).toEqual([]);
});
test('exception does not bypass service area restrictions',async()=>{
 ServiceArea.findOne.mockReturnValue(lean({type:'zip_codes',zipCodes:['99999']}));
 const result=await withStaffSchedulingException(exception,()=>AvailabilityService.getAvailability(args));
 expect(result.supportedServiceArea).toBe(false);expect(result.slots).toEqual([]);
});
