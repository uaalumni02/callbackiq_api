import { evaluateServicePolicy, preferSpecificServices } from '../../src/services/serviceEligibility/policy.js';
import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
import { formatApprovedServiceEstimate } from '../../src/services/booking/serviceEstimatePolicy.js';
import { evaluateDeterministicInboundGuardrails, detectSensitiveData } from '../../src/helpers/ai/aiGuardrails.js';
const trades=[['plumbing','faucet replacement'],['hvac','furnace repair'],['electrical','outlet repair'],['roofing','roof repair'],['restoration','water damage restoration'],['garage_door','garage door repair'],['locksmith','door lock replacement'],['landscaping','hedge trimming']];
const modes=['approved','no_price','no_booking','human_review','no_discussion','inactive','business_exclusion','offering_exclusion'];
const cases=trades.flatMap(([businessTrade])=>trades.flatMap(([requestTrade,request])=>modes.flatMap(mode=>[true,false].flatMap(complete=>['service','repair','general'].map(name=>({businessTrade,requestTrade,request,mode,complete,name}))))));
test.each(cases)('catalog authorization %# %j', ({businessTrade,requestTrade,request,mode,complete,name})=>{
 const tradeName=businessTrade.replace('_',' ');
 const service={_id:'s',active:mode!=='inactive',name:`${name==='general'?'General ':''}${tradeName} ${name==='general'?'service':name}`,category:businessTrade,aiCanDiscuss:mode!=='no_discussion',aiCanBook:mode!=='no_booking',requiresHumanReview:mode==='human_review',disclosePriceEstimate:mode!=='no_price',excludedKeywords:mode==='offering_exclusion'?[request]:[]};
 const policy={catalogComplete:complete,excludedServices:mode==='business_exclusion'?[request]:[]};
 const result=evaluateServicePolicy({request,services:[service],policy});
 const excluded=mode==='business_exclusion'||mode==='offering_exclusion';
 const matched=businessTrade===requestTrade&&mode!=='inactive'&&!excluded;
 if(excluded) expect(result.decision).toBe('unsupported');
 else if(!matched) expect(result.decision).toBe(complete?'unsupported':'needs_staff_review');
 else if(['human_review','no_discussion'].includes(mode)) expect(result.decision).toBe('needs_staff_review');
 else {
  expect(result.decision).toBe('supported');
  expect(result.canBook).toBe(mode!=='no_booking');
  expect(result.canEstimate).toBe(mode!=='no_price');
 }
});
test.each(trades)('%s follow-up pronouns cannot redefine the job',(_,request)=>{
 for(const text of ['How much to fix it?','Can you repair it tomorrow?','What is the estimated price to repair and when can you come fix it?','Can I schedule an appointment?']) {
  expect(extractService(text,{lead:{serviceNeeded:request}})).toBe('');
 }
});
test('specific service supersedes only the broad offering of the same trade',()=>{
 const broad={name:'Plumbing Repair',category:'plumbing'},specific={name:'Faucet replacement',category:'plumbing'},roof={name:'Roofing',category:'roofing'};
 expect(preferSpecificServices([broad,specific,roof])).toEqual([specific,roof]);
});
test.each([null,undefined,-1,Infinity,NaN,'150'])('invalid price never leaks: %s',amount=>{
 expect(formatApprovedServiceEstimate({disclosePriceEstimate:true,priceEstimateMin:amount,priceEstimateMax:200})).toBe('');
});
test('ZIP+4 is retained while actual SSN patterns still trigger protection',()=>{
 expect(evaluateDeterministicInboundGuardrails({customerMessage:'970 Sidney Marcus Atlanta GA 30324-1234'}).handled).toBe(false);
 expect(detectSensitiveData('123-45-6789')).toContain('ssn');
 expect(detectSensitiveData('123456789')).toContain('ssn');
});
test.each(['sprinkler','thermostat','skylight','deadbolt'])('a concrete %s after this is still a service change',object=>{
 expect(extractService(`How much to replace this ${object}?`,{lead:{serviceNeeded:'faucet replacement'}})).toContain(object);
});
