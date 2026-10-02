import { multiTradeCases, testOffering } from '../fixtures/multiTradeCases.js';
import { evaluateServicePolicy, serviceDomains } from '../../src/services/serviceEligibility/policy.js';
import { assessTradeQualification } from '../../src/services/trades/tradeQualification.service.js';
import { getTradeSetup } from '../../src/services/trades/tradeSetup.service.js';
import { BUSINESS_TYPES } from '../../src/helpers/businessTypes.js';
import { recoveryLeakQuestion } from '../../src/services/booking/recoveryIntakePresentation.service.js';
import { createServiceOfferingSchema } from '../../src/validator/businessConfiguration.js';
import ServiceOffering from '../../src/models/serviceOffering.js';
import { extractService } from '../../src/services/messaging/smsIntentClassifier.service.js';
const decide=(row,request=row.request,extra={})=>evaluateServicePolicy({request,services:[testOffering(row)],policy:{catalogComplete:true},...extra});
test.each(multiTradeCases)('$trade owner-created category-general service matches customer evidence',row=>{
 expect(decide(row)).toMatchObject({decision:'supported',serviceId:'s1',canBook:true});
 expect(extractService(row.request)).not.toBe('');
});
test.each(multiTradeCases.flatMap(a=>multiTradeCases.filter(b=>a.trade!==b.trade).map(b=>[a,b])))('%s never authorizes another trade %s',(a,b)=>{
 expect(decide(a,b.request).decision).not.toBe('supported');
});
test.each([
 ['AC repair','Install a new AC'],['Furnace repair','My AC is not cooling'],['Lawn care','Remove a tree'],['Refrigerator repair','My washer is not draining'],['Door lock rekeying','I am locked out'],['Home lockout','I am locked out of my car'],['Garage opener repair','My garage door spring snapped'],['Roof inspection','Replace my roof'],['Outlet repair','Replace my electrical panel']
])('narrow offering %s cannot authorize %s',(name,request)=>{
 expect(decide({name},request).decision).not.toBe('supported');
 expect(decide({name},request,{semanticService:name,confidence:99}).decision).not.toBe('supported');
});
test('category alone never grants every service within a trade',()=>{
 const service={...testOffering({name:'AC repair'}),category:'hvac'};
 expect(evaluateServicePolicy({request:'Furnace repair',services:[service]}).decision).not.toBe('supported');
});
test.each(multiTradeCases)('$trade exclusions and permissions remain authoritative',row=>{
 expect(decide(row,row.request,{policy:{excludedServices:[row.request]}}).decision).toBe('unsupported');
 expect(decide(row,row.request,{services:[{...testOffering(row),aiCanDiscuss:false}]}).decision).toBe('needs_staff_review');
 expect(decide(row,row.request,{services:[{...testOffering(row),aiCanBook:false}]}).canBook).toBe(false);
 expect(decide(row,row.request,{services:[{...testOffering(row),active:false}]}).decision).not.toBe('supported');
});
test('appliance cooling is not spuriously an HVAC request',()=>expect(serviceDomains('My fridge has no cooling')).toEqual(['appliance_repair']));
test.each(BUSINESS_TYPES)('%s setup drafts are validated and inactive',trade=>{
 const setup=getTradeSetup(trade); expect(setup.suggestedServices.length).toBeGreaterThan(0);
 for(const service of setup.suggestedServices){
  expect(service).toMatchObject({active:false,aiCanBook:false,requiresHumanReview:true});
  expect(createServiceOfferingSchema.validate(service).error).toBeUndefined();
  const model=new ServiceOffering({...service,business:'507f1f77bcf86cd799439011',nameKey:service.name});
  expect(model.validateSync()).toBeUndefined();
 }
});
test.each([
 ['My roof is leaking',/rain/],['My AC is leaking',/substance/],['My AC is leaking refrigerant',/refrigerant/],['My water heater is leaking',/only when you use/]
])('leak question respects equipment and substance: %s',(service,pattern)=>{
 const q=recoveryLeakQuestion(service);expect(q).toMatch(pattern);
 if(/roof|refrigerant/.test(service)) expect(q).not.toMatch(/only when you use|Is water leaking/);
});
test.each(multiTradeCases)('$trade qualification captures required answers without altering the service',row=>{
 let previous=assessTradeQualification({service:row.request,category:row.trade,text:row.request});
 for(const [i,text] of row.answers.entries()) previous=assessTradeQualification({service:row.request,category:row.trade,text,previous:{...previous,asked:true},turnId:String(i)});
 expect(previous.status).toBe('clear');expect(previous.serviceKey).toBe(row.request.toLowerCase());
});
test('interrupts, replays, corrections and uncertain answers are bounded',()=>{
 const args={service:'My garage door spring snapped',category:'garage_door'};
 let previous={...assessTradeQualification(args),asked:true};
 expect(assessTradeQualification({...args,previous,text:'Tomorrow',factualTurn:true}).attempts).toBe(0);
 previous=assessTradeQualification({...args,previous,text:'not sure what you mean',turnId:'a'});
 expect(previous.status).toBe('needs_staff_review');
 previous={...assessTradeQualification(args),asked:true};
 previous=assessTradeQualification({...args,previous,text:'purple',turnId:'a'});
 expect(assessTradeQualification({...args,previous,text:'purple',turnId:'a'}).attempts).toBe(1);
 expect(assessTradeQualification({...args,previous,text:'purple',turnId:'b'}).status).toBe('needs_staff_review');
 const clear=assessTradeQualification({...args,previous,text:'The door is closed. 123 Easy Street 30324. Tomorrow.',factualTurn:true});
 expect(clear.status).toBe('clear');
 expect(assessTradeQualification({...args,service:'My garage opener is broken',previous:clear,correction:true}).status).toBe('needs_clarification');
});
test.each(['Weekly lawn mowing','My AC is leaking refrigerant'])('nonstandard work stays blocked at revalidation: %s',service=>{
 const state=assessTradeQualification({service,text:service});expect(state.status).toBe('needs_staff_review');
 expect(assessTradeQualification({service,previous:state}).status).toBe('needs_staff_review');
});
test('negated refrigerant leak does not create a substance escalation',()=>{
 expect(assessTradeQualification({service:'My AC is not leaking refrigerant',text:''}).reason).not.toBe('non_water_leak_review');
});

test('an estimate question is not mistaken for a different requested operation',()=>{
 expect(decide({name:'AC repair'},'Can I get an estimate for AC repair?').decision).toBe('supported');
});
test('multiple equipment requests are not reduced to the single supported part',()=>{
 expect(decide({name:'AC repair'},'My AC and furnace are not working').reason).toBe('mixed_service_request');
});

test('corrections replace trade details without reusing availability evidence',()=>{
 const args={service:'My garage door spring snapped',category:'garage_door'};
 const first=assessTradeQualification({...args,text:'The door is closed'});
 const next=assessTradeQualification({...args,previous:first,text:'Actually the door is open now'});
 expect(next.answers.door_position).toBe('Actually the door is open now');
 expect(next.status).toBe('clear');
});
test('explicit one-time correction supersedes a recurring preference without changing the service',()=>{
 const args={service:'Weekly lawn mowing',category:'landscaping'};
 const first=assessTradeQualification({...args,text:args.service});expect(first.status).toBe('needs_staff_review');
 const next=assessTradeQualification({...args,previous:first,text:'Actually just a one-time visit instead'});
 expect(next.status).toBe('clear');expect(next.answers.job_frequency).toContain('one-time');
});

test.each(['My gas water heater is leaking water','My fridge leaks water, not refrigerant'])('equipment fuel and denied substances do not invent a substance hazard: %s',service=>{
 const r=assessTradeQualification({service,text:service});expect(r.reason).not.toBe('non_water_leak_review');expect(r.hazardType).toBeUndefined();
});
