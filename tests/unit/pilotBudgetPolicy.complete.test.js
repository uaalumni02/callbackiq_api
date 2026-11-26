import { pilotBudget, pilotVoiceLimits, providerDispatchPaused, withPilotVoiceBudget } from '../../src/config/pilotBudgets.js';
import { numericSetting } from '../../src/config/numericSettings.js';
jest.mock('../../src/config/numericSettings.js', () => ({numericSetting: jest.fn(name => require('../../config/numeric-settings.json')[name].default)}));
beforeEach(() => jest.clearAllMocks());
test.each([
 ['voice',1800,18000,18000,180000],
 ['sms',300,3000,1500,15000],
 ['ai',100,1000,500,5000],
])('B03 %s reserves in the provider unit from the central plan', (metric,daily,monthly,fleetDaily,fleetMonthly) => {
 expect(pilotBudget(metric)).toEqual({daily,monthly,fleetDaily,fleetMonthly});
 expect(numericSetting).toHaveBeenCalledTimes(4);
});
test.each([undefined,'',false,'video'])('B03 unsupported provider budget %p fails before any numeric lookup',metric=>{
 expect(()=>pilotBudget(metric)).toThrow(TypeError);expect(numericSetting).not.toHaveBeenCalled();
});
test('B03 a supplied configuration source is delegated unchanged and voice always has no overage',()=>{
 const source={PILOT_VOICE_MINUTES_DAY:'30'};
 expect(pilotVoiceLimits(source)).toMatchObject({dailySeconds:1800,monthlySeconds:18000,hardCapEnabled:true,overageEnabled:false});
 expect(numericSetting.mock.calls.every(([,passed])=>passed===source)).toBe(true);
 expect(pilotVoiceLimits()).toMatchObject({hardCapEnabled:true,overageEnabled:false});
});
test.each([
 [undefined,false],['',false],['false',false],['FALSE',false],['true',true],['TRUE',true],['0',true],[' false ',true],['garbled',true],
])('B03 operator circuit input %p is interpreted conservatively',(value,expected)=>{
 expect(providerDispatchPaused({PILOT_PROVIDER_DISPATCH_PAUSED:value})).toBe(expected);
});
test('B03 a missing operator environment is open only when no pause was requested',()=>{
 const old=process.env.PILOT_PROVIDER_DISPATCH_PAUSED;
 delete process.env.PILOT_PROVIDER_DISPATCH_PAUSED;
 try{expect(providerDispatchPaused()).toBe(false);}finally{if(old!==undefined)process.env.PILOT_PROVIDER_DISPATCH_PAUSED=old;}
});
test('B03 legacy owner values cannot disable or increase the published plan',()=>{
 expect(withPilotVoiceBudget({dailyVoiceMinutes:99999,monthlyVoiceMinutes:99999,voiceHardCapEnabled:false,voiceOverageEnabled:true,answerMode:'after_hours'})).toMatchObject({dailyVoiceMinutes:30,monthlyVoiceMinutes:300,voiceHardCapEnabled:true,voiceOverageEnabled:false,answerMode:'after_hours'});
});
