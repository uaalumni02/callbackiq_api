import {assertTransition,getSlotKey,getSlotClaimKeys} from '../../src/services/scheduling/appointmentStatePolicy.service.js';
import {createNonBlockingAppointmentSideEffect} from '../../src/services/scheduling/appointmentEffectAdapter.service.js';
import {BUSINESS_SCOPE_FIELDS,CONVERSATION_INTELLIGENCE_LEAD_FIELDS} from '../../src/db/repositories/dbProjectionFields.js';
import {hasBookingAvailabilityHint,isAffirmative,isNegative} from '../../src/services/booking/bookingMessagePolicy.service.js';
test('extracted booking lexical decisions',()=>{
 expect(hasBookingAvailabilityHint('tomorrow afternoon')).toBe(true);
 expect(isAffirmative('yes, that works')).toBe(true);
 expect(isAffirmative('no, not yet')).toBe(false);
 expect(isNegative('not yet')).toBe(true);
});
test('transition contract and rejection code',()=>{
 expect(()=>assertTransition('held','confirmed')).not.toThrow();
 let error;try{assertTransition('confirmed','held');}catch(e){error=e;}
 expect(error).toMatchObject({code:'INVALID_APPOINTMENT_TRANSITION',statusCode:409});
});
test('deterministic slot and lane keys',()=>{
 expect(getSlotKey('2026-10-30T15:00:00Z','2026-10-30T15:30:00Z')).toBe('2026-10-30T15:00:00.000Z|2026-10-30T15:30:00.000Z');
 expect(getSlotClaimKeys({startAt:'2026-10-30T15:00:00Z',endAt:'2026-10-30T15:02:00Z',capacityLane:2})).toEqual(['2026-10-30T15:00:00.000Z|lane:2','2026-10-30T15:01:00.000Z|lane:2']);
});
test('DB projection fields retained',()=>{
 expect(BUSINESS_SCOPE_FIELDS).toContain('owner');
 expect(CONVERSATION_INTELLIGENCE_LEAD_FIELDS).toContain('serviceNeeded');
});
test('nonblocking effect failure retains staff escalation',async()=>{
 const logger={error:jest.fn()},alerts={create:jest.fn().mockResolvedValue(undefined)};
 const run=createNonBlockingAppointmentSideEffect({safeConsole:logger,InterventionService:alerts});
 expect(await run({appointment:{_id:'a',business:'b',lead:'l'},label:'confirmation',task:async()=>{throw new Error('provider failure');}})).toBeNull();
 expect(logger.error).toHaveBeenCalledTimes(1);
 expect(alerts.create).toHaveBeenCalledWith(expect.objectContaining({businessId:'b',appointmentId:'a',type:'integration_failure'}));
});
