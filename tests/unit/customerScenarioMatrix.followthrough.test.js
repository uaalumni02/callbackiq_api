import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import AlertService from '../../src/services/alert.service.js';
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn() } }));
const now = new Date('2026-09-08T14:00:00Z');
const address = '87 Oak Lane Marietta GA 30060';
function context(channel = 'sms', trade = 'plumbing') {
 const lead = {_id:'l1',serviceNeeded:'Unknown',urgency:'medium',phone:'+14045550100',save:jest.fn().mockResolvedValue(null)};
 const conversation = {_id:'c1',status:'open',bookingState:{status:'not_started'},conversationMemory:{},save:jest.fn().mockResolvedValue(null),set(path,value){this.conversationMemory.recoveryIntake=value;}};
 const ctx = {business:{_id:'b1',businessName:`Test ${trade}`,businessType:trade,timezone:'America/New_York',features:{aiBookingEnabled:false}},lead,conversation,channel,session:{_id:'v1'},now};
 ctx.turn = (customerMessage,semanticAssessment=null) => handleRecoveryIntake({...ctx,customerMessage,semanticAssessment});
 return ctx;
}
beforeEach(() => {
 jest.clearAllMocks(); getApprovedServiceEstimate.mockResolvedValue('');
 validateServiceArea.mockResolvedValue({supported:true}); searchServices.mockResolvedValue([{id:'s1',score:1}]);
 getAvailability.mockResolvedValue({slots:[{startAt:'2026-09-09T08:00:00-04:00',endAt:'2026-09-09T09:00:00-04:00'}]});
 AlertService.createHumanHandoffAlert.mockResolvedValue({_id:'a1'});
});
const scenarios = [
 ['HVAC','My AC is blowing warm air. How much does a repair cost?','AC repair'],
 ['electrical','I need a ceiling fan installed. What is the cost?','ceiling fan installation'],
 ['roofing','Several shingles are missing. How much would replacement cost?','shingle replacement'],
 ['garage_door','My garage door will not open. How much does a repair cost?','garage door repair'],
 ['locksmith','I need my front door lock replaced. How much does it cost?','lock replacement'],
 ['landscaping','I need hedge trimming. How much does it cost?','hedge trimming'],
];
describe.each(['sms','voice'])('%s customer scenario matrix', channel => {
 test.each(scenarios)('%s captures service plus price without invented cost or repeat-service loop',async(trade,text,service)=>{
  const c=context(channel,trade);
  const result=await c.turn(text,{isInScope:true,confidence:95,serviceNeeded:service});
  expect(result).not.toBeNull(); expect(c.lead.serviceNeeded).not.toBe('Unknown');
  expect(result.reply).toMatch(/price/i); expect(result.reply).not.toMatch(/\$\d|right away|shortly|what service|didn.t understand/i);
  expect(result.intakeReady).toBe(false); expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
 });
 test('mixed service/address/date/time preserves every supplied fact and requires approval',async()=>{
  const c=context(channel,'HVAC');
  const result=await c.turn(`AC not cooling, ${address}, Wed Sep 9 at 8 am`,{isInScope:true,confidence:95,serviceNeeded:'AC not cooling',address,preferredAppointmentTime:'2026-09-09 at 08:00'});
  expect(c.lead.address).toBe(address); expect(c.lead.preferredAppointmentTime).toMatch(/2026-09-09.*8:00/);
  expect(result.intakeReady).toBe(true); expect(result.intakeCompletionReply).toMatch(/not confirmed/);
  expect(result.intakeCompletionReply).not.toMatch(/you.re booked|shortly|right away/i);
 });
 test('address correction replaces old address without changing service',async()=>{
  const c=context(channel); await c.turn('My kitchen sink needs replacing'); await c.turn('123 Main St Marietta GA 30060');
  await c.turn(`Correction, the address is ${address}`,{isInScope:true,confidence:95,serviceNeeded:'kitchen sink replacement',address});
  expect(c.lead.address).toBe(address); expect(c.lead.serviceNeeded).toMatch(/sink/i);
 });
 test('time correction preserves previously supplied day',async()=>{
  const c=context(channel); await c.turn('My kitchen sink needs replacing'); await c.turn('Wed Sep 9 at 8 am');
  await c.turn('Actually make that 10 am');
  expect(c.lead.preferredAppointmentTime).toBe('2026-09-09 at 10:00');
 });
 test.each(['No longer leaking','Only when I use the shower','It stopped leaking'])('leak negation avoids emergency and preserves observed pattern: %s',async text=>{
  const c=context(channel); await c.turn('My shower is leaking'); const result=await c.turn(text);
  expect(c.lead.urgency).toBe('medium'); expect(result.reply).toMatch(/address/i);
  expect(c.conversation.conversationMemory.recoveryIntake.triageAnswer).toBe(text);
 });
 test('unsupported service cannot authorize availability',async()=>{
  const c=context(channel,'electrical'); searchServices.mockResolvedValue([]);
  const result=await c.turn('My roof needs repair',{isInScope:false,confidence:95,serviceNeeded:'roof repair'});
  if(result) expect(result.reply).not.toMatch(/we (?:do|handle)|available|booked/i);
  expect(getAvailability).not.toHaveBeenCalled(); expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
 });
 test('ambiguous semantic guess cannot start an invented request',async()=>{
  const c=context(channel); expect(await c.turn('that thing is acting funny',{isInScope:true,confidence:35,serviceNeeded:'water heater replacement'})).toBeNull();
  expect(c.lead.serviceNeeded).toBe('Unknown'); expect(c.lead.save).not.toHaveBeenCalled();
 });
 test.each(['STOP','Please stop texting me','I want a human','Please call me instead'])('control request bypasses intake without mutating customer facts: %s',async text=>{
  const c=context(channel); await c.turn('My kitchen sink needs replacing'); c.lead.save.mockClear();
  expect(await c.turn(text)).toBeNull(); expect(c.lead.save).not.toHaveBeenCalled(); expect(getAvailability).not.toHaveBeenCalled();
 });
 test('staff ownership bypasses intake even when fresh scheduling facts arrive',async()=>{
  const c=context(channel); c.conversation.humanTakeover=true;
  expect(await c.turn('My AC needs repair tomorrow at 8 am')).toBeNull(); expect(c.lead.save).not.toHaveBeenCalled();
 });
});
test('voice-to-SMS continues a roofing request without reasking captured address or day',async()=>{
 const c=context('voice','roofing'); await c.turn('My roof has missing shingles',{isInScope:true,confidence:95,serviceNeeded:'roof shingle replacement'}); await c.turn(address); await c.turn('Wed Sep 9');
 const result=await handleRecoveryIntake({...c,channel:'sms',customerMessage:'8 am'});
 expect(c.lead.serviceNeeded).toMatch(/roof|shingles/i); expect(c.lead.address).toBe(address);
 expect(result.intakeReady).toBe(true); expect(result.intakeCompletionReply).toContain(address); expect(result.intakeCompletionReply).toMatch(/not confirmed/);
 expect(AlertService.createHumanHandoffAlert).not.toHaveBeenCalled();
});

test.each(['sms','voice'])('%s reassesses leak pattern after customer switches fixtures',async channel=>{
 const c=context(channel); await c.turn('My toilet is leaking'); await c.turn('Only when used');
 const result=await c.turn('Actually my kitchen sink is leaking');
 expect(c.lead.serviceNeeded).toMatch(/sink/i);
 expect(result.reply).toMatch(/leaking right now|continuously|only when/i);
 expect(c.conversation.conversationMemory.recoveryIntake.triagePending).toBe(true);
 expect(c.conversation.conversationMemory.recoveryIntake.triageResolved).not.toBe(true);
});

test.each(['sms','voice'])('%s captures a date/time appended to a street address without semantic reprocessing',async channel=>{
 const c=context(channel); await c.turn('My kitchen sink needs replacing');
 const result=await c.turn(`${address}, Wed Sep 9 at 8 am`);
 expect(c.lead.address).toBe(address);
 expect(c.lead.preferredAppointmentTime).toBe('2026-09-09 at 8:00');
 expect(result.intakeReady).toBe(true);
});
