import {numericDefinitions,numericSetting,validateNumericSettings} from '../../src/config/numericSettings.js';
import {workerSetting,validateWorkerSettings} from '../../src/config/workerSettings.js';

test.each(Object.keys(numericDefinitions))('%s has an explicit default, unit and zero policy',name=>{
 const definition=numericDefinitions[name];
 expect(['unlimited','default','rejected']).toContain(definition.zero);
 expect(definition.unit).toEqual(expect.any(String));
 for(const value of [undefined,null,'',' \t '])expect(numericSetting(name,{[name]:value})).toBe(definition.default);
 expect(Object.isFrozen(definition)).toBe(true);
});
test.each(['garbage','NaN','Infinity','1.25','9007199254740992'])('registered values reject malformed or unsafe %p',value=>{
 for(const name of Object.keys(numericDefinitions))expect(()=>numericSetting(name,{[name]:value})).toThrow();
});
test('startup validates every registered limit rather than stopping at a valid first entry',()=>{
 expect(()=>validateNumericSettings({TRIAL_MAX_ADMIN_EXTENSION_DAYS:'14',WORKER_DRAIN_TIMEOUT_MS:'0'})).toThrow(/WORKER_DRAIN_TIMEOUT_MS/);
 expect(()=>validateNumericSettings({TRIAL_MAX_ADMIN_EXTENSION_DAYS:'broken',WEBHOOK_WORK_CONCURRENCY:'broken'})).toThrow(/TRIAL_MAX_ADMIN_EXTENSION_DAYS/);
});
test('the compatibility worker reader uses the shared numeric policy',()=>{
 expect(workerSetting('WEBHOOK_WORK_CONCURRENCY',{WEBHOOK_WORK_CONCURRENCY:'   '})).toBe(5);
 expect(()=>workerSetting('WEBHOOK_WORK_CONCURRENCY',{WEBHOOK_WORK_CONCURRENCY:'0'})).toThrow();
 expect(()=>validateWorkerSettings({BILLING_INTEGRITY_INTERVAL_MS:'bad'})).toThrow(/BILLING_INTEGRITY_INTERVAL_MS/);
 expect(()=>workerSetting('TRIAL_MAX_ADMIN_EXTENSION_DAYS',{})).toThrow(/Unknown worker/);
});
test('zero policies are explicit and preserve existing history clamping',()=>{
 expect(numericSetting('TRIAL_MAX_ADMIN_EXTENSION_DAYS',{TRIAL_MAX_ADMIN_EXTENSION_DAYS:'0'})).toBe(0);
 expect(numericSetting('AI_ANALYSIS_HISTORY_LIMIT',{AI_ANALYSIS_HISTORY_LIMIT:'0'})).toBe(200);
 expect(numericSetting('AI_ANALYSIS_HISTORY_LIMIT',{AI_ANALYSIS_HISTORY_LIMIT:'10000'})).toBe(500);
 expect(numericSetting('AI_ANALYSIS_HISTORY_LIMIT',{AI_ANALYSIS_HISTORY_LIMIT:'1'})).toBe(20);
 expect(()=>numericSetting('UNREGISTERED_LIMIT',{})).toThrow(/Unknown numeric/);
});
