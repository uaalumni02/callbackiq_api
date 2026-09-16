import { getOrLoadScaleCache as get, clearLocalScaleCache, closeScaleCache } from '../../src/services/scaleCache.service.js';
import { safeConsole } from '../../src/helpers/logging/safeLogger.js';
let mockClient;
jest.mock('../../src/services/boundedRedis.service.js',()=>({
 ...jest.requireActual('../../src/services/boundedRedis.service.js'),
 createBoundedRedis:()=>({execute:operation=>operation(mockClient),close:jest.fn()})
}));
const saved={...process.env};let values,now;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
beforeEach(()=>{
 values=new Map();now=Date.now();jest.spyOn(Date,'now').mockImplementation(()=>now);
 jest.spyOn(safeConsole,'error').mockImplementation(()=>{});
 process.env.SCALE_CACHE_ENABLED='true';process.env.REDIS_URL='redis://test';process.env.SCALE_CACHE_NAMESPACE='test';
 delete process.env.SCALE_CACHE_REDIS_URL;delete process.env.SOCKET_REDIS_URL;
 clearLocalScaleCache();
 mockClient={get:jest.fn(async key=>values.get(key)||null),set:jest.fn(async(key,value,options)=>{if(options.NX&&values.has(key))return null;values.set(key,value);return 'OK';}),
 eval:jest.fn(async(_,{keys,arguments:a})=>{if(values.get(keys[0])!==a[0])return 0;if(keys.length===2)values.set(keys[1],a[1]);values.delete(keys[0]);return 1;})};
});
afterEach(async()=>{await flush();clearLocalScaleCache();process.env={...saved};jest.restoreAllMocks();});
test('cold Redis miss publishes and a second process can reuse the result without loading',async()=>{
 const loader=jest.fn(async()=>42);expect(await get({key:'key',loader})).toBe(42);clearLocalScaleCache();
 expect(await get({key:'key',loader})).toBe(42);expect(loader).toHaveBeenCalledTimes(1);expect(mockClient.eval).toHaveBeenCalled();
});
test('only a Redis outage permits a bounded local fallback',async()=>{
 mockClient.get.mockRejectedValue(new Error('offline'));
 expect(await get({key:'key',loader:async()=>7})).toBe(7);
});
test('ordinary loader failures are not retried as Redis outages',async()=>{
 const loader=jest.fn(async()=>{throw new Error('query failed');});
 await expect(get({key:'key',loader})).rejects.toThrow('query failed');expect(loader).toHaveBeenCalledTimes(1);
});
test.each(['not-json','null','{}','{"freshUntil":"bad"}','{"freshUntil":1,"staleUntil":"bad"}'])('invalid cached envelope is rebuilt: %s',async raw=>{
 values.set('test:key',raw);expect(await get({key:'key',loader:async()=>3})).toBe(3);
});
test('local stale reads return promptly and coalesce background refreshes',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const loader=jest.fn().mockResolvedValueOnce(1).mockImplementation(async()=>{await gate;return 2;});
 await get({key:'key',loader,ttlMs:100,staleMs:5000});now+=200;
 expect(await get({key:'key',loader,ttlMs:100,staleMs:5000})).toBe(1);
 expect(await get({key:'key',loader,ttlMs:100,staleMs:5000})).toBe(1);
 await flush();release();await flush();await flush();expect(await get({key:'key',loader})).toBe(2);
 expect(loader).toHaveBeenCalledTimes(2);
});
test('distributed stale results remain usable when background refresh fails',async()=>{
 values.set('test:key',JSON.stringify({value:4,freshUntil:now-1,staleUntil:now+5000}));
 const loader=jest.fn(async()=>{throw new Error('database busy');});
 expect(await get({key:'key',loader})).toBe(4);await flush();await flush();
 expect(await get({key:'key',loader})).toBe(4);expect(loader).toHaveBeenCalledTimes(1);
});
test('fully expired memory is not served',async()=>{
 let n=0;const options={key:'key',loader:async()=>++n,ttlMs:100,staleMs:100};
 await get(options);now+=200;expect(await get(options)).toBe(2);await closeScaleCache();
});
test('cold keys waiting on other replicas cannot grow the inflight set without bound',async()=>{
 process.env.SCALE_CACHE_MAX_LOADERS='1';mockClient.set.mockResolvedValue(null);
 const requests=Array.from({length:4},(_,i)=>get({key:`blocked:${i}`,loader:async()=>{throw new Error('must not load');}}));
 const settled=Promise.allSettled(requests);await flush();await flush();
 await expect(get({key:'overflow',loader:async()=>1})).rejects.toMatchObject({code:'CACHE_REFRESH_BUSY'});
 now+=2000;expect((await settled).every(x=>x.status==='rejected')).toBe(true);
});
test('many stale tenants refresh independently while bounded cache entries rotate',async()=>{
 process.env.SCALE_CACHE_MEMORY_MAX_ENTRIES='50';
 for(let i=0;i<55;i++){
  values.set(`test:tenant:${i}`,JSON.stringify({value:i,freshUntil:now-1,staleUntil:now+5000}));
  expect(await get({key:`tenant:${i}`,loader:async()=>i+1})).toBe(i);await flush();await flush();
 }
});
