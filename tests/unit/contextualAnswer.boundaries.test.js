import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { isContextualSymptomAnswer } from '../../src/services/booking/contextualServiceAnswer.service.js';
import { classifyLeakActivityAnswer } from '../../src/services/booking/leakActivityAnswer.service.js';
import { detectSafetyHazardType, isUrgentPlumbingRequest } from '../../src/helpers/ai/aiGuardrails.js';
import { classifyInboundSmsCommand } from '../../src/services/messaging/contactPreference.service.js';
test.each([
 ['furnace repair',"it doesn't heat"],['air conditioner repair','its not cooling'],
 ['roof leak','Still leaking bad'],['outlet repair','it is still dead'],
 ['water damage restoration','it is still wet'],['garage door repair',"it won't open"],
 ['door lock repair',"it won't lock"],['sprinkler repair','it keeps leaking'],
])('symptom keeps canonical service: %s / %s',(service,text)=>{
 expect(isContextualSymptomAnswer(text,service)).toBe(true);
 const extracted=extractService(text,{lead:{serviceNeeded:service}});
 if(extracted) expect(extracted.toLowerCase()).toContain(service.split(' ')[0].toLowerCase());
});
test.each(['leaking roof','leaking toilet','I need furnace repair','My toilet is clogged','It leaks and my toilet is clogged','Actually replace the faucet instead'])('explicit work remains available to service interpretation: %s',text=>{expect(isContextualSymptomAnswer(text,'sink repair')).toBe(false);});
test('fixture correction still replaces the old object',()=>{expect(extractService("It's the bathroom sink, not the kitchen sink",{lead:{serviceNeeded:'kitchen sink leaking'}})).toMatch(/bathroom sink/);});
test.each(['My toilet is overflowing. My address is 123 Main Street Atlanta GA 30324','My toilet is overflowing at 123 Main Street Atlanta GA 30324','My toilet is overflowing, please call me','My toilet is overflowing today'])('logistics do not create danger: %s',text=>{expect(isUrgentPlumbingRequest(text)).toBe(true);expect(detectSafetyHazardType(text)).toBe('');});
test.each(["My toilet is overflowing at 123 Main Street and I can't stop it",'My toilet is overflowing and water is running across the floor','My toilet is overflowing at 123 Main Street and I smell gas','My toilet is overflowing at 123 Main Street and water is pouring','My toilet is overflowing near an electrical outlet'])('danger is never downgraded: %s',text=>{expect(isUrgentPlumbingRequest(text)).toBe(false);expect(detectSafetyHazardType(text)).not.toBe('');});
test.each(["I do not want to opt out", "Don't unsubscribe me","Do not stop sending me texts",'How do I opt out?'])('negative/informational consent: %s',text=>{expect(classifyInboundSmsCommand(text).handled).toBe(false);});
test('explicit opt-out survives unrelated negation',()=>{expect(classifyInboundSmsCommand("Don't stop the repair, stop texting me").action).toBe('opt_out');});
test.each([['It leaks when I turn the faucet on','during_use'],['It stopped after I shut off the water','not_active'],['Still leaking badly','active']])('normalizes pending leak evidence: %s',(text,value)=>{expect(classifyLeakActivityAnswer({text,service:'pipe leak',state:{triagePending:true,field:'leak_activity'}})).toBe(value);});
test.each(['No overflowing or backing up into other fixtures','No overflowing','It is overflowing','It is backing up','Not backing up'])('clog symptom preserves service: %s',text=>{
 expect(isContextualSymptomAnswer(text,'toilet is clogged')).toBe(true);
 const extracted=extractService(text,{lead:{serviceNeeded:'toilet is clogged'}});
 if(extracted) expect(extracted).toContain('toilet is clogged');
});
test.each(['My roof is leaking','It is overflowing and my roof is leaking','I need another toilet installed'])('clog context must not hide different work: %s',text=>{
 expect(isContextualSymptomAnswer(text,'toilet is clogged')).toBe(false);
});
