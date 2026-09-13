import { createVoiceAdmission } from '../../src/services/voiceAdmission.service.js';
afterEach(()=>{delete process.env.VOICE_FLEET_MAX_AI_TURNS;});
test('a short burst waits for an available slot without exceeding active capacity',async()=>{
 const a=createVoiceAdmission({turns:1,waitMs:200});let finish;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await new Promise(r=>setTimeout(r,1));
 const second=a.runTurn(async()=>7);expect(a.snapshot().waiting).toBe(1);
 finish();await first;expect(await second).toBe(7);expect(a.snapshot().turns).toBe(0);
});
test('canceled queued turns cannot execute later',async()=>{
 const a=createVoiceAdmission({turns:1,waitMs:200});let finish;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await new Promise(r=>setTimeout(r,1));
 const controller=new AbortController(),operation=jest.fn();
 const second=a.runTurn(operation,{signal:controller.signal});controller.abort(new Error('canceled'));
 await expect(second).rejects.toThrow('canceled');finish();await first;expect(operation).not.toHaveBeenCalled();expect(a.snapshot().waiting).toBe(0);
});
test('queue deadline and bound preserve fallback under sustained overload',async()=>{
 const a=createVoiceAdmission({turns:1,waitMs:30,maxWaiting:1});let finish;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await new Promise(r=>setTimeout(r,1));
 const second=a.runTurn(async()=>{});const rejection=expect(second).rejects.toMatchObject({code:'VOICE_ADMISSION_FULL'});
 await expect(a.runTurn(async()=>{})).rejects.toMatchObject({code:'VOICE_ADMISSION_FULL'});
 await rejection;finish();await first;
});
