import { dateWindows, validateWindows } from '../../src/services/scheduling/availabilityWindows.service.js';
import { arrivalWindow, customerAppointmentLabel, renderAppointmentResponse } from '../../src/services/scheduling/customerAppointmentPresentation.service.js';
import { withStaffSchedulingException, runStaffSchedulingRequest } from '../../src/services/scheduling/staffSchedulingException.service.js';
import { effectiveSchedulingPolicy } from '../../src/services/scheduling/effectiveSchedulingPolicy.service.js';
const date='2026-09-28';
const rules=[{dayOfWeek:1,enabled:true,windows:[{startTime:'09:00',endTime:'17:00'}]}];
const run=exceptions=>dateWindows({dateKey:date,rules,exceptions});
test('one-hour closure keeps morning and afternoon capacity',()=>{
 expect(run([{date,type:'closure',allDay:false,windows:[{startTime:'12:00',endTime:'13:00'}]}])).toEqual([[540,720],[780,1020]]);
});
test('overlapping partial blocks combine and full-day blocks win over special openings',()=>{
 expect(run([{date,type:'technician_meeting',allDay:false,windows:[{startTime:'12:00',endTime:'14:00'}]},{date,type:'closure',allDay:false,windows:[{startTime:'13:00',endTime:'15:00'}]}])).toEqual([[540,720],[900,1020]]);
 expect(run([{date,type:'special_hours',windows:[{startTime:'10:00',endTime:'12:00'}]},{date,type:'closure',allDay:true}])).toEqual([]);
});
test('fully booked and emergency-only do not turn off office answering',()=>{
 for(const type of ['fully_booked','emergency_only']) {
 const exceptions=[{date,type,allDay:true}];expect(run(exceptions)).toEqual([]);
 expect(dateWindows({dateKey:date,rules,exceptions,scope:'answering'})).toEqual([[540,1020]]);
 }
});
test('overnight carry is blocked by next-day holiday',()=>{
 const night=[{dayOfWeek:0,enabled:true,windows:[{startTime:'22:00',endTime:'02:00'}]}];
 expect(dateWindows({dateKey:date,rules:night})).toEqual([[0,120]]);
 expect(dateWindows({dateKey:date,rules:night,exceptions:[{date,type:'holiday',allDay:true}]})).toEqual([]);
});
test('answering and appointment periods remain independent',()=>{
 const split=[{...rules[0],separateAnsweringHours:true,answeringEnabled:true,answeringWindows:[{startTime:'07:00',endTime:'19:00'}]}];
 expect(dateWindows({dateKey:date,rules:split,scope:'answering'})).toEqual([[420,1140]]);
 expect(dateWindows({dateKey:date,rules:split,exceptions:[{date,type:'closure',allDay:true,appliesTo:'answering'}]})).toEqual([[540,1020]]);
});
test('24-hour opening and overnight validation are explicit, overlapping periods rejected',()=>{
 expect(()=>validateWindows([{startTime:'22:00',endTime:'02:00'}])).not.toThrow();
 expect(()=>validateWindows([{startTime:'00:00',endTime:'24:00'}])).not.toThrow();
 expect(()=>validateWindows([{startTime:'09:00',endTime:'09:00'}])).toThrow();
 expect(()=>validateWindows([{startTime:'22:00',endTime:'02:00'},{startTime:'01:00',endTime:'03:00'}])).toThrow();
});
test('arrival window is independent of job length and exact mode has no implicit change',()=>{
 const startAt='2026-09-28T13:30:00Z';expect(arrivalWindow(startAt,'UTC',{})).toEqual({});
 const window=arrivalWindow(startAt,'UTC',{appointmentStyle:'arrival_window',arrivalWindowMinutes:120});
 expect(window).toEqual({arrivalStartAt:new Date('2026-09-28T12:00:00Z'),arrivalEndAt:new Date('2026-09-28T14:00:00Z')});
 expect(customerAppointmentLabel({startAt,...window},'UTC')).toMatch(/12:00 PM–2:00 PM arrival window/);
});
test('spring DST window never creates an invalid date',()=>{
 const value=arrivalWindow('2027-03-14T07:30:00Z','America/New_York',{appointmentStyle:'arrival_window',arrivalWindowMinutes:120});
 expect(Number.isFinite(value.arrivalStartAt.getTime())).toBe(true);expect(value.arrivalEndAt>value.arrivalStartAt).toBe(true);
});
test('voice read-back uses spoken confirmation and expiry never promises a callback',()=>{
 expect(renderAppointmentResponse({kind:'review',label:'Friday at 10',service:'sink repair',address:'125 Main'},'voice')).toMatch(/Is that correct/);
 expect(renderAppointmentResponse({kind:'expired'})).not.toMatch(/will call|shortly|confirmed for/);
});
test('short-notice permission does not leak between businesses or asynchronous operations',async()=>{
 const policy={minimumNoticeMinutes:1440,allowSameDayBooking:false};const service={_id:'s1'};
 const run=()=>effectiveSchedulingPolicy(policy,service,{businessId:'b1',startAt:'2026-09-28T10:00Z'});
 const result=await withStaffSchedulingException({businessId:'b1',serviceOfferingId:'s1',startAt:'2026-09-28T10:00Z'},async()=>{await Promise.resolve();return run();});
 expect(result.minimumNoticeMinutes).toBe(0);expect(run().minimumNoticeMinutes).toBe(1440);
 await expect(runStaffSchedulingRequest({business:{_id:'b1'},input:{schedulingException:{allowShortNotice:true,reason:'unverified staff request'}}},async()=>true)).rejects.toMatchObject({statusCode:400});
});

test('a closed overnight shift does not leak into the following day',()=>{
 const night=[{dayOfWeek:0,enabled:true,windows:[{startTime:'22:00',endTime:'02:00'}]}];
 expect(dateWindows({dateKey:date,rules:night,exceptions:[{date:'2026-09-27',type:'holiday',allDay:true}]})).toEqual([]);
});
test('an overnight partial block also blocks the following day’s own opening',()=>{
 const early=[{dayOfWeek:1,enabled:true,windows:[{startTime:'00:00',endTime:'04:00'}]}];
 expect(dateWindows({dateKey:date,rules:early,exceptions:[{date:'2026-09-27',type:'closure',allDay:false,windows:[{startTime:'23:00',endTime:'02:00'}]}]})).toEqual([[120,240]]);
});
