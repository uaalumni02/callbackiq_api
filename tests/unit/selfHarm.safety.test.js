import { evaluateDeterministicInboundGuardrails, detectSafetyHazardType, getEmergencyReply } from '../../src/helpers/ai/aiGuardrails.js';
import { assessInboundSafety } from '../../src/services/safetyAssessmentService.js';
import { classifyVoiceTurn } from '../../src/voice/voiceUnderstanding.service.js';
import { routeSafety } from '../../src/voice/voiceTurn/routeSafety.js';
import { captureCallback } from '../../src/voice/voiceTurn/context.js';
import { createOpenAIClient } from '../../src/integrations/providerClients.js';
jest.mock('../../src/integrations/providerClients.js',()=>({createOpenAIClient:jest.fn()}));
jest.mock('../../src/voice/voiceTurn/context.js',()=>({
 AlertService:{createAIReviewAlert:jest.fn()},assertVoiceTurnActive:jest.fn(),
 captureCallback:jest.fn(args=>({reply:args.completionReply})),captureTurnFacts:jest.fn(()=>({})),classifySmsIntent:jest.fn(()=>({})),observeCustomerConstraint:jest.fn(),respectCustomerConstraints:jest.fn(reply=>reply),
}));
const reply="If you're thinking about suicide or hurting yourself, call or text 988 (Suicide & Crisis Lifeline) now. If you're in immediate danger, call 911. This service does not monitor emergencies.";
beforeEach(()=>jest.clearAllMocks());
test.each(['suicidal','want to die','kill myself','hurt myself','end my life','end it all','suicide'])('%s bypasses AI on SMS and voice and routes a critical owner escalation',async phrase=>{
 const text=`I ${phrase}`;
 expect(detectSafetyHazardType(text)).toBe('self_harm');expect(getEmergencyReply('self_harm')).toBe(reply);
 expect(evaluateDeterministicInboundGuardrails({customerMessage:text})).toMatchObject({hazardType:'self_harm',reply,skipAI:true,shouldAlertOwner:true,alertPriority:'critical'});
 expect(await assessInboundSafety({customerMessage:text})).toMatchObject({hazardType:'self_harm',reply,shouldAlertOwner:true,alertPriority:'critical',source:'deterministic'});
 const understanding=await classifyVoiceTurn({customerMessage:text});
 expect(understanding).toMatchObject({source:'deterministic',intent:'emergency',safety:{hazardType:'self_harm',reply}});
 const lead={save:jest.fn(),notes:''};
 const result=await routeSafety({text,safety:understanding.safety,lead,conversation:{_id:'c'},business:{_id:'b'},session:{_id:'s'}});
 expect(result).toMatchObject({completed:true,value:{reply}});
 expect(captureCallback).toHaveBeenCalledWith(expect.objectContaining({reason:'safety_emergency:self_harm',priority:'critical',alertType:'safety_emergency',immediate:true,sendConfirmationSms:false,completionReply:reply}));
 expect(lead.urgency).toBe('emergency');expect(createOpenAIClient).not.toHaveBeenCalled();
});
test.each(['I am not suicidal','I do not want to die','I will not kill myself','I will not hurt myself','I will not end my life','I will not end it all'])('negated self-harm stays untriggered: %s',text=>expect(detectSafetyHazardType(text)).toBe(''));
test('quoted song title remains a documented conservative false positive',()=>{
 expect(detectSafetyHazardType("my kid's song is called kill myself")).toBe('self_harm');
});
