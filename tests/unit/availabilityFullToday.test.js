jest.mock('../../src/models/availabilityException.js', () => ({__esModule:true,default:{exists:jest.fn(),findOneAndUpdate:jest.fn(),updateMany:jest.fn()}}));
jest.mock('../../src/models/serviceOffering.js', () => ({__esModule:true,default:{find:jest.fn()}}));
jest.mock('../../src/services/businessScope.service.js', () => ({__esModule:true,default:jest.fn()}));
jest.mock('../../src/services/scheduling/appointmentPolicy.service.js', () => ({getSchedulingPolicy:jest.fn()}));
jest.mock('../../src/services/scheduling/availability.service.js', () => ({__esModule:true,default:{}}));
import AvailabilityController from '../../src/controllers/availability.js';
import AvailabilityException from '../../src/models/availabilityException.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import getOwnedBusiness from '../../src/services/businessScope.service.js';
import {getSchedulingPolicy} from '../../src/services/scheduling/appointmentPolicy.service.js';
const run = async (method='GET',body={}) => {
 const res={json:jest.fn()};const next=jest.fn();
 await AvailabilityController.fullToday({method,body,user:{userId:'owner'}},res,next);
 return {data:res.json.mock.calls[0]?.[0],next};
};
beforeEach(() => {
 jest.clearAllMocks();jest.useFakeTimers().setSystemTime(new Date('2026-10-01T01:30:00Z'));
 getOwnedBusiness.mockResolvedValue({_id:'business-1',timezone:'America/New_York'});
 getSchedulingPolicy.mockResolvedValue({allowSameDayBooking:false});
 ServiceOffering.find.mockReturnValue({lean:jest.fn().mockResolvedValue([])});
 AvailabilityException.exists.mockResolvedValue(null);
});
afterEach(() => jest.useRealTimers());
test('reports saved state and business-local date across UTC midnight',async () => {
 const {data}=await run();expect(data).toMatchObject({date:'2026-09-30',timeZone:'America/New_York',blocked:false,sameDayBookingEnabled:false});
 expect(AvailabilityException.exists).toHaveBeenCalledWith(expect.objectContaining({business:'business-1',date:'2026-09-30',active:true}));
});
test('service same-day override remains visible when global same-day is off',async () => {
 ServiceOffering.find.mockReturnValue({lean:jest.fn().mockResolvedValue([{allowSameDayBookingOverride:true}])});
 expect((await run()).data.sameDayBookingEnabled).toBe(true);
});
test('all services overriding global allowance to false report same-day off',async () => {
 getSchedulingPolicy.mockResolvedValue({allowSameDayBooking:true});
 ServiceOffering.find.mockReturnValue({lean:jest.fn().mockResolvedValue([{allowSameDayBookingOverride:false}])});
 expect((await run()).data.sameDayBookingEnabled).toBe(false);
});
test('removal stays available with same-day disabled and touches only dashboard block',async () => {
 const {data}=await run('POST',{blocked:false,date:'2026-09-30'});
 expect(data).toMatchObject({blocked:false,sameDayBookingEnabled:false});
 expect(AvailabilityException.updateMany).toHaveBeenCalledWith({business:'business-1',date:'2026-09-30',type:'fully_booked',name:'Dashboard booking block',appliesTo:'appointments'},{$set:{active:false}});
});
test('pause preserves original appointment-only date-specific write',async () => {
 expect((await run('POST',{blocked:true})).data.blocked).toBe(true);
 expect(AvailabilityException.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({date:'2026-09-30',appliesTo:'appointments'}),{$set:{active:true,allDay:true,windows:[],capacity:0}},{upsert:true,new:true,runValidators:true});
});
test('stale date and invalid payload cannot change another day',async () => {
 expect((await run('POST',{blocked:true,date:'2026-09-29'})).next).toHaveBeenCalledWith(expect.objectContaining({statusCode:409}));
 expect((await run('POST',{blocked:'true'})).next).toHaveBeenCalledWith(expect.objectContaining({statusCode:400}));
 expect(AvailabilityException.findOneAndUpdate).not.toHaveBeenCalled();
});
test('failed persistence forwards error instead of returning success',async () => {
 AvailabilityException.updateMany.mockRejectedValueOnce(new Error('Database unavailable'));
 const result=await run('POST',{blocked:false});expect(result.data).toBeUndefined();expect(result.next).toHaveBeenCalledWith(expect.any(Error));
});
