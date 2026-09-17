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
test('FIFO admission prevents a newly arrived turn overtaking older callers', async () => {
 const a=createVoiceAdmission({turns:1,waitMs:1000}); const order=[]; let finish;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;})); await new Promise(r=>setTimeout(r,1));
 const older=a.runTurn(async()=>{order.push('older');});
 finish();
 const newer=a.runTurn(async()=>{order.push('newer');});
 await Promise.all([first,older,newer]); expect(order).toEqual(['older','newer']);
 expect(a.snapshot()).toMatchObject({turns:0,waiting:0});
});
test('aborting the queue head wakes its successor and does not leak a reservation', async () => {
 const a=createVoiceAdmission({turns:1,waitMs:1000});let finish;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await new Promise(r=>setTimeout(r,1));
 const c=new AbortController();const head=a.runTurn(jest.fn(),{signal:c.signal});
 const rejected=expect(head).rejects.toThrow('abort head');const next=a.runTurn(async()=>42);
 c.abort(new Error('abort head'));await rejected;finish();await first;expect(await next).toBe(42);
 expect(a.snapshot()).toMatchObject({turns:0,waiting:0});
});
test('fleet denial, cancellation and provider failure release every local and fleet slot', async()=>{
 const release=jest.fn(async()=>{});const acquire=jest.fn().mockRejectedValueOnce(Object.assign(new Error('full'),{code:'VOICE_ADMISSION_FULL'})).mockResolvedValue(release);
 const a=createVoiceAdmission({turns:1,waitMs:300,acquireFleetSlot:acquire});
 await expect(a.runTurn(async()=>{throw new Error('provider failed');})).rejects.toThrow('provider failed');
 expect(release).toHaveBeenCalledTimes(1);expect(a.snapshot()).toMatchObject({turns:0,waiting:0});
});
test('queue and execution timing are separate and telemetry errors cannot fail a turn',async()=>{
 const a=createVoiceAdmission({turns:1,waitMs:1000});let finish;let sample;
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await new Promise(r=>setTimeout(r,1));
 const second=a.runTurn(async()=>9,{onTiming:x=>{sample=x;throw new Error('metrics failed');}});
 await new Promise(r=>setTimeout(r,30));finish();await first;expect(await second).toBe(9);
 expect(sample.queueWaitMs).toBeGreaterThanOrEqual(20);expect(sample.processingMs).toBeLessThan(sample.queueWaitMs);
 expect(a.snapshot().timing.completed).toBe(2);
});
test('expired queued work never starts even if capacity frees before its timer runs',async()=>{
 const a=createVoiceAdmission({turns:1,waitMs:10});let finish;const operation=jest.fn();
 const first=a.runTurn(()=>new Promise(r=>{finish=r;}));await new Promise(r=>setTimeout(r,1));
 const second=a.runTurn(operation);const check=expect(second).rejects.toMatchObject({code:'VOICE_ADMISSION_FULL'});
 const end=performance.now()+20;while(performance.now()<end){} finish();await first;await check;
 expect(operation).not.toHaveBeenCalled();expect(a.snapshot()).toMatchObject({turns:0,waiting:0});
});
