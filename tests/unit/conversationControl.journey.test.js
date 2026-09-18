jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn().mockResolvedValue({ supported: true, reason: 'matched' }) }));
import { generateAIReplyResult } from '../../src/services/aiReplyService.js';
import { handleConversationControl, isRequestWithdrawal } from '../../src/services/conversationControl.service.js';
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import Booking from '../../src/services/booking/bookingStateMachine.service.js';
import Catalog from '../../src/models/serviceOffering.js';
import Operations from '../../src/models/businessOperationsSettings.js';
import Alert from '../../src/services/alert.service.js';
import availability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import search from '../../src/helpers/ai/tools/searchServices.tool.js';
import cancel from '../../src/helpers/ai/tools/cancelAppointment.tool.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
import { runFollowUpAgent } from '../../src/helpers/ai/followUpAgent.js';
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule:true, default:{find:jest.fn()} }));
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule:true, default:{findOne:jest.fn()} }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule:true, default:{create:jest.fn(),createSystemAlert:jest.fn(),createHumanHandoffAlert:jest.fn()} }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule:true, default:jest.fn() }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule:true, default:jest.fn() }));
jest.mock('../../src/helpers/ai/tools/cancelAppointment.tool.js', () => ({ __esModule:true, default:jest.fn() }));
jest.mock('../../src/helpers/ai/followUpAgent.js', () => ({runFollowUpAgent:jest.fn()}));
jest.mock('../../src/helpers/ai/qualifyLeadWithAI.js', () => ({qualifyLeadWithAI:jest.fn().mockRejectedValue(new Error('Unexpected model use'))}));
function context(channel='sms') {
 const c={channel,business:{_id:'b1',businessName:'Atlanta Pro Plumbing & Drain',businessType:'plumbing',timezone:'America/New_York',features:{aiBookingEnabled:false}},
 lead:{_id:'l1',serviceNeeded:'Unknown',urgency:'medium',save:jest.fn().mockResolvedValue(null)},
 conversation:{_id:'c1',status:'open',bookingState:{status:'not_started'},conversationMemory:{},lifecycle:{},orchestration:{recoveryJourneyKey:'j1'},save:jest.fn().mockResolvedValue(null),set(path,value){let target=this;const keys=path.split('.');for(const key of keys.slice(0,-1))target=target[key]??={};target[keys.at(-1)]=value;}}};
 c.turn=async customerMessage=>{
  if(channel==='sms')return generateAIReplyResult({...c,customerMessage});
  const params={...c,customerMessage};
  const control=await handleConversationControl(params);if(control)return control;
  const intake=await handleRecoveryIntake(params);if(intake)return intake;
  return (await Booking.handle(params)).result;
 };
 return c;
}
beforeEach(()=>{
 jest.clearAllMocks();
 Catalog.find.mockReturnValue(catalogQuery([approvedOffering('s1','plumbing')]));
 Operations.findOne.mockReturnValue(catalogQuery({serviceEligibilityPolicy:{catalogComplete:true}}));
 search.mockResolvedValue([{id:'s1',name:'Plumbing repair',score:1}]);
 const start=new Date(Date.now()+3*86400000);start.setUTCHours(12,0,0,0);
 availability.mockResolvedValue({supportedServiceArea:true,slots:[{startAt:start,endAt:new Date(+start+3600000)}]});
 Alert.create.mockResolvedValue({alert:{_id:'a1'}});Alert.createSystemAlert.mockResolvedValue({alert:{_id:'a1'}});
 cancel.mockResolvedValue({status:'canceled'});
});
describe.each(['sms','voice'])('%s shared conversation journey',channel=>{
 test('leak → availability → delayed answer → selection → acceptance question → address → help → withdrawal',async()=>{
  const c=context(channel);
  expect((await c.turn('My bathroom sink is leaking')).reply).toMatch(/right now|only when/);
  expect((await c.turn('When can someone come out')).reply).toMatch(/Current openings/);
  const offers=c.conversation.bookingState.offeredSlots;
  const triage=await c.turn("It's leaking constantly");
  expect(triage.reply).toMatch(/continuously/);expect(c.lead.urgency).toBe('high');
  expect(c.conversation.conversationMemory.recoveryIntake.triageAnswer).toBe("It's leaking constantly");
  expect(c.conversation.bookingState.offeredSlots).toEqual(offers);
  expect((await c.turn('1')).reply).toMatch(/not confirmed.*address/);
  expect(Alert.create).toHaveBeenCalledWith(expect.objectContaining({title:'Customer selected an appointment time'}));
  expect((await c.turn("When will I know it's accepted?")).reply).toMatch(/response time|timeframe/);
  expect((await c.turn('1234 Link Street Atlanta GA 30324')).reply).toMatch(/saved.*address/);
  expect(c.lead.address).toMatch(/1234 Link Street/);
  expect((await c.turn('What can I do about the sink for right now')).reply).toMatch(/Avoid using/);
  expect((await c.turn("Never mind. I don't need your service. You're not helpful")).reply).toMatch(/withdrawn/);
  expect(c.lead.status).toBe('lost');expect(c.conversation.bookingState.offeredSlots).toEqual([]);
  expect(c.conversation.conversationMemory.recoveryIntake.withdrawnAt).toBeTruthy();
  expect(Alert.create).toHaveBeenCalledWith(expect.objectContaining({title:'Customer withdrew service request',actionRequired:true}));
  expect((await c.turn('1')).reply).toMatch(/withdrawn/);
  expect(runFollowUpAgent).not.toHaveBeenCalled();
 });
 test.each(['offering_slots','awaiting_confirmation','pending_business_confirmation','booked','human_takeover'])('cancellation during %s',async status=>{
  const c=context(channel);c.conversation.bookingState={status,appointment:['booked','pending_business_confirmation'].includes(status)?'a1':null};
  const r=await c.turn('Cancel my appointment');
  expect(r.reply).toMatch(/canceled|withdrawn/);
  if(['booked','pending_business_confirmation'].includes(status))expect(cancel).toHaveBeenCalledWith(expect.objectContaining({appointmentId:'a1',business:c.business}));
 });
 test('failed provider cancellation is not acknowledged as completed',async()=>{
  const c=context(channel);c.conversation.bookingState={status:'booked',appointment:'a1'};cancel.mockRejectedValueOnce(new Error('provider unavailable'));
  const r=await c.turn('Cancel my appointment');expect(r.reply).toMatch(/could not confirm/);expect(c.conversation.bookingState.appointment).toBe('a1');
  expect(Alert.create).toHaveBeenCalledWith(expect.objectContaining({title:'Customer cancellation needs action'}));
 });
});
test.each(["Don't cancel my appointment",'How can I cancel my appointment?','What if I cancel my appointment?','What is the cancellation fee?','Never mind the sink, my toilet is leaking'])('does not withdraw on a question or negation: %s',text=>expect(isRequestWithdrawal(text)).toBe(false));
test('database failure prevents withdrawal acknowledgement',async()=>{
 const c=context();c.conversation.save.mockRejectedValueOnce(new Error('database unavailable'));
 await expect(handleConversationControl({...c,customerMessage:'Cancel my appointment'})).rejects.toThrow('database unavailable');
 expect(cancel).not.toHaveBeenCalled();expect(Alert.create).not.toHaveBeenCalled();
});

test('missing staff-task acknowledgement cannot become a submitted slot request', async () => {
 const c=context();await c.turn('My bathroom sink is leaking');await c.turn('When can someone come out');
 Alert.create.mockResolvedValueOnce({alert:null});
 const r=await c.turn('1');expect(r.reply).not.toMatch(/sent your request|submitted your request/);
 expect(c.conversation.bookingState.status).toBe('offering_slots');
});
test('failed cancellation remains explicitly unconfirmed on subsequent questions', async () => {
 const c=context();c.conversation.bookingState={status:'booked',appointment:'a1'};
 cancel.mockRejectedValueOnce(new Error('provider unavailable'));await c.turn('Cancel my appointment');
 expect((await c.turn('What happens now?')).reply).toMatch(/cancellation is not confirmed/);
});
test.each(['offering_slots','pending_business_confirmation','human_takeover'])('safety overrides routine questions in %s', async status => {
 const c=context();c.conversation.bookingState.status=status;
 const r=await c.turn('I smell gas. What can I do right now?');
 expect(r.messageCategory).toBe('emergency');expect(r.reply).not.toMatch(/What is happening/);expect(cancel).not.toHaveBeenCalled();
});
test('new recovery journey does not inherit an old withdrawal', async () => {
 const c=context();await c.turn("I don't need your service");
 c.conversation.orchestration.recoveryJourneyKey='j2';
 const r=await c.turn('My bathroom sink is leaking');expect(r.reply).not.toMatch(/withdrawn/);
});

test('immediate help for a non-leaking fixture does not invent a leak', async () => {
 const c=context();c.lead.serviceNeeded='sink replacement';
 const r=await c.turn('What can I do right now?');expect(r.reply).not.toMatch(/water coming|wet areas/);
});
