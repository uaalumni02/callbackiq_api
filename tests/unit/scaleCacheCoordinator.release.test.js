import assert from 'node:assert/strict';
import { createCacheRefreshCoordinator } from '../../src/services/scale/cacheRefresh.service.js';
function fakeRedis() {
  const values = new Map();
  const get = key => { const value = values.get(key); if (value?.until <= Date.now()) { values.delete(key); return null; } return value?.data || null; };
  const client = { get: async key => get(key), set: async (key, data, options) => {
    if (options.NX && get(key)) return null;
    values.set(key, { data, until: Date.now() + options.PX }); return 'OK';
  }, eval: async (_script, { keys, arguments: args }) => {
    if (get(keys[0]) !== args[0]) return 0;
    if (keys.length === 2) values.set(keys[1], { data: args[1], until: Date.now() + Number(args[2]) });
    values.delete(keys[0]); return 1;
  } };
  return { values, execute: operation => operation(client) };
}
test('independent replicas share one cold refresh and reuse its publication', async () => {
  const redis = fakeRedis(); let loads = 0;
  const replicas = Array.from({length: 6}, () => createCacheRefreshCoordinator({ execute: redis.execute, pollMs: 5 }));
  const load = async () => { loads++; await new Promise(r => setTimeout(r, 30)); return { total: 12 }; };
  const results = await Promise.all(replicas.map(run => run({ key: 'tenant:a', load, ttlMs: 1000, staleMs: 3000 })));
  assert.equal(loads, 1); assert.ok(results.every(x => x.value.total === 12));
});
test('a busy cold key times out without running another database loader', async () => {
  const redis = fakeRedis(); redis.values.set('key:refresh', { data: 'other', until: Date.now() + 10000 });
  let loads = 0;
  const run = createCacheRefreshCoordinator({ execute: redis.execute, waitMs: 20, pollMs: 5 });
  await assert.rejects(run({ key: 'key', load: async () => ++loads, ttlMs: 1000, staleMs: 3000 }), { code: 'CACHE_REFRESH_BUSY' });
  assert.equal(loads, 0);
});
test('a stale replica never overwrites a newer owner after losing its token', async () => {
  const redis = fakeRedis();
  const run = createCacheRefreshCoordinator({ execute: redis.execute });
  await assert.rejects(run({ key: 'key', ttlMs: 1000, staleMs: 3000, load: async () => {
    redis.values.set('key:refresh', { data: 'new-owner', until: Date.now() + 10000 }); return 'old-result';
  } }), { code: 'CACHE_REFRESH_BUSY' });
  assert.equal(redis.values.get('key:refresh').data, 'new-owner');
  assert.equal(redis.values.has('key'), false);
});
test('shared stale data can be served during another owners refresh', async () => {
  const redis = fakeRedis(), stale = { value: 7, freshUntil: 1, staleUntil: Date.now() + 1000 };
  redis.values.set('key', { data: JSON.stringify(stale), until: stale.staleUntil });
  redis.values.set('key:refresh', { data: 'other', until: Date.now() + 10000 });
  const result = await createCacheRefreshCoordinator({ execute: redis.execute })({ key: 'key', load: async () => { throw new Error('must not load'); } });
  assert.equal(result.value, 7);
});
test('failed loader releases its refresh ownership and allows another request to retry',async()=>{
 const redis=fakeRedis(),run=createCacheRefreshCoordinator({execute:redis.execute});
 await assert.rejects(run({key:'key',load:async()=>{throw new Error('database timeout');},ttlMs:1000,staleMs:3000}),/database timeout/);
 assert.equal(redis.values.has('key:refresh'),false);
 assert.equal((await run({key:'key',load:async()=>17,ttlMs:1000,staleMs:3000})).value,17);
});
test('invalid/expired shared payloads are replaced and a fresh publication avoids a loader',async()=>{
 for(const raw of ['not-json','null',JSON.stringify({value:'old',freshUntil:1,staleUntil:2})]){
  const redis=fakeRedis();redis.values.set('key',{data:raw,until:Date.now()+10000});
  const run=createCacheRefreshCoordinator({execute:redis.execute});
  assert.equal((await run({key:'key',load:async()=>3,ttlMs:1000,staleMs:3000})).value,3);
  assert.equal((await run({key:'key',load:async()=>{throw new Error('unneeded');},ttlMs:1000,staleMs:3000})).value,3);
 }
});
test('cold owner rechecks a publication made between the read and lock acquisition',async()=>{
 const redis=fakeRedis();let reads=0;
 const execute=async operation=>operation({get:async()=>++reads===1?null:JSON.stringify({value:9,freshUntil:Date.now()+1000,staleUntil:Date.now()+3000}),set:async()=>true,eval:async()=>1});
 const run=createCacheRefreshCoordinator({execute});
 assert.equal((await run({key:'key',load:async()=>{throw new Error('must not load');},ttlMs:1000,staleMs:3000})).value,9);
});
test('a busy owner may serve a still-valid local stale value',async()=>{
 const redis=fakeRedis();redis.values.set('key:refresh',{data:'owner',until:Date.now()+1000});
 const stale={value:5,staleUntil:Date.now()+1000};
 assert.equal((await createCacheRefreshCoordinator({execute:redis.execute})({key:'key',stale,load:async()=>0})).value,5);
});
