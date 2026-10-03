import { findDateRange } from '../../src/services/booking/appointmentPreferenceParser.service.js';
import { recoveryCompletionReply } from '../../src/services/booking/recoveryIntakePresentation.service.js';
import { workflowVersion } from '../../src/services/businessRequestWorkflow.service.js';
const now=new Date('2026-10-03T16:22:00Z');
test.each(['Next week, Tuesday afternoon would work.','Tuesday next week','Next week on Tuesday','early next week, Tuesday','Tuesday of next week'])('specific weekday wins: %s',text=>{
 expect(findDateRange(text,'America/New_York',now)).toEqual({startDate:'2026-10-06',endDate:'2026-10-06'});
});
test.each([['Monday','2026-10-05'],['Wednesday','2026-10-07'],['Thursday','2026-10-08'],['Friday','2026-10-09'],['Saturday','2026-10-10'],['Sunday','2026-10-11']])('next week %s retains day',(day,date)=>{
 expect(findDateRange(`Next week, ${day}`,'America/New_York',now)).toEqual({startDate:date,endDate:date});
});
test('bare next week remains a range',()=>expect(findDateRange('next week','America/New_York',now)).toEqual({startDate:'2026-10-05',endDate:'2026-10-11'}));
test.each(['sms','voice'])('%s summary uses authoritative service, not repeated turn history',channel=>{
 const reply=recoveryCompletionReply({channel,lead:{serviceNeeded:'pipe repair',address:'123 Peachtree St, Atlanta, GA 30303'},state:{serviceDetail:'pipe repair; pipe repair; Still leaking bad',date:'2026-10-06',time:'afternoon'}});
 expect(reply.match(/pipe repair/g)).toHaveLength(1);expect(reply).not.toContain('Still');expect(reply).toContain('Tue, Oct 6');expect(reply).toContain('not confirmed');
 if(channel==='sms')expect(reply.length).toBeLessThanOrEqual(320);
});
const snapshot={conversation:{humanTakeover:true},lead:{serviceNeeded:'pipe repair'},members:[],latestOutbound:{_id:'m1',body:'Received',status:'sent',createdAt:'2026-10-03'}};
test('ordinary message receipt does not invalidate staff action',()=>{
 expect(workflowVersion({...snapshot,latestOutbound:{...snapshot.latestOutbound,status:'delivered',deliveryStatus:'delivered',deliveryUncertain:false}})).toBe(workflowVersion(snapshot));
});
test.each([{latestOutbound:{...snapshot.latestOutbound,_id:'m2'}},{lead:{serviceNeeded:'furnace repair'}},{appointment:{status:'confirmed'}},{confirmationNotice:{status:'failed'}}])('meaningful concurrent changes still conflict',change=>{
 expect(workflowVersion({...snapshot,...change})).not.toBe(workflowVersion(snapshot));
});
