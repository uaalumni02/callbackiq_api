jest.mock('../../src/services/boundedRedis.service.js',()=>({createBoundedRedis:()=>({execute:jest.fn(async fn=>fn({eval:jest.fn().mockResolvedValue(0)}))})}));
import {createVoiceAdmission} from '../../src/services/voiceAdmission.service.js';
afterEach(()=>{delete process.env.VOICE_FLEET_MAX_AI_TURNS;});
test('fleet saturation times out without executing and releases counters',async()=>{
 process.env.VOICE_FLEET_MAX_AI_TURNS='1';const a=createVoiceAdmission({waitMs:30});const operation=jest.fn();
 await expect(a.runTurn(operation)).rejects.toMatchObject({code:'VOICE_ADMISSION_FULL'});
 expect(operation).not.toHaveBeenCalled();expect(a.snapshot()).toMatchObject({turns:0,waiting:0,rejected:1});
});
test('pre-aborted signal without reason uses stale-turn fallback',async()=>{
 const a=createVoiceAdmission();const operation=jest.fn();
 await expect(a.runTurn(operation,{signal:{aborted:true}})).rejects.toMatchObject({code:'VOICE_STALE_TURN'});
 expect(operation).not.toHaveBeenCalled();expect(a.snapshot().turns).toBe(0);
});
test('aborting during queue registration rejects without leaking waiters',async()=>{
 const a=createVoiceAdmission({turns:1,waitMs:100});let finish;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await Promise.resolve();
 const signal={aborted:false,addEventListener:jest.fn((event,fn)=>{signal.aborted=true;}),removeEventListener:jest.fn()};
 const operation=jest.fn();await expect(a.runTurn(operation,{signal})).rejects.toMatchObject({code:'VOICE_STALE_TURN'});
 finish();await first;expect(operation).not.toHaveBeenCalled();expect(a.snapshot()).toMatchObject({waiting:0,turns:0});expect(signal.removeEventListener).toHaveBeenCalled();
});
