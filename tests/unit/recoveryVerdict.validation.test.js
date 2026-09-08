import { validateVoiceVerdict } from '../../src/voice/voiceUnderstanding.service.js';
import { constrainUncertainReply } from '../../src/services/messaging/uncertainReply.service.js';
const fallback={intent:'service_request',confidence:65,entities:{service:'prior'},safety:{isEmergency:false,shouldSendSafetyReply:false}};
const valid={intent:'booking',confidence:90,language:'en',entities:{service:'toilet repair'},safety:{isEmergency:false,shouldSendSafetyReply:false}};
test.each([{...valid,intent:'dispatch_technician'},{...valid,confidence:'100'},{...valid,confidence:40},{...valid,entities:{service:{instruction:'book now'}}},{...valid,safety:{isEmergency:'false'}}])('malformed or uncertain voice classifications cannot invent actions', verdict => {
 const result=validateVoiceVerdict(verdict,fallback); expect(result.intent).toBe(fallback.intent); expect(result.entities).toEqual(fallback.entities); expect(result.entities.service).not.toBe('toilet repair');
});
test('voice model safety text is replaced by the controlled safety reply',()=>{
 const r=validateVoiceVerdict({...valid,safety:{isEmergency:true,shouldSendSafetyReply:true,hazardType:'gas',reply:'Your technician is dispatched'}},fallback);
 expect(r.reply).toBeUndefined(); expect(r.safety.reply).not.toMatch(/technician is dispatched/);
});
test('SMS low confidence preserves facts and escalates on the second distinct unclear turn',async()=>{
 const conversation={conversationMemory:{},set(path,value){this.conversationMemory[path.split('.')[1]]=value},save:jest.fn().mockResolvedValue(null)};
 const lead={serviceNeeded:'toilet repair',address:'970 Sidney Marcus Blvd',preferredAppointmentTime:'Sep 8 at 8 am',urgency:'high'};
 const result={decision:'send',confidence:20,serviceNeeded:'guessed service',address:'guessed address',reply:'Booked!',guardrail:{skipAI:false}};
 const one=await constrainUncertainReply({conversation,lead,result,turnId:'1'}); expect(one.address).toBe(lead.address); expect(one.handoff).toBeUndefined();
 await constrainUncertainReply({conversation,lead,result,turnId:'1'}); expect(conversation.conversationMemory.uncertainTurns).toBe(1);
 const two=await constrainUncertainReply({conversation,lead,result,turnId:'2'}); expect(two.handoff.reason).toBe('intake_unclear'); expect(two.preferredAppointmentTime).toBe(lead.preferredAppointmentTime);
 await constrainUncertainReply({conversation,lead,result:{...result,confidence:90},turnId:'3'}); expect(conversation.conversationMemory.uncertainTurns).toBe(0);
});
