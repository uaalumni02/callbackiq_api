import { createAwaitedKeyBatch } from '../../src/services/database/awaitedKeyBatch.js';
const turn = () => new Promise(resolve => setImmediate(resolve));

test('batches independent identities while serializing retries for one identity', async () => {
  let finish;
  const seen = [];
  const batch = createAwaitedKeyBatch({ execute: rows => {
    seen.push(rows);
    if (seen.length === 1) return new Promise(resolve => { finish = () => resolve(rows); });
    return Promise.resolve(rows);
  } });
  const a = batch.enqueue('a', 1);
  const retry = batch.enqueue('a', 2);
  const b = batch.enqueue('b', 3);
  await turn(); await turn();
  expect(seen).toEqual([[1, 3]]);
  finish();
  expect(await Promise.all([a, retry, b])).toEqual([1, 2, 3]);
  expect(seen).toEqual([[1, 3], [2]]);
});

test('failed writes reject every affected caller and release identities for retry', async () => {
  const error = new Error('uncertain write');
  let fail = true;
  const batch = createAwaitedKeyBatch({ execute: rows => {
    if (fail) { fail = false; throw error; }
    return rows;
  } });
  const results = await Promise.allSettled([batch.enqueue('a', 1), batch.enqueue('b', 2)]);
  expect(results.every(result => result.status === 'rejected' && result.reason === error)).toBe(true);
  await expect(batch.enqueue('a', 3)).resolves.toBe(3);
  expect(batch.diagnostics().failedBatches).toBe(1);
});

test('queue capacity refuses work explicitly without dropping accepted promises', async () => {
  const batch = createAwaitedKeyBatch({ execute: rows => rows, maxQueued: 2 });
  const a = batch.enqueue('a', 1);
  const b = batch.enqueue('b', 2);
  await expect(batch.enqueue('c', 3)).rejects.toMatchObject({ code: 'SMS_INGRESS_QUEUE_FULL' });
  expect(await Promise.all([a, b])).toEqual([1, 2]);
});

test('limits batch size and concurrent batches under a burst', async () => {
  let active = 0; let peak = 0;
  const sizes = [];
  const batch = createAwaitedKeyBatch({ maxBatchSize: 3, maxConcurrent: 2, execute: async rows => {
    active++; peak = Math.max(peak, active); sizes.push(rows.length);
    await turn(); active--; return rows;
  } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => batch.enqueue(String(i), i)));
  expect(peak).toBeLessThanOrEqual(2);
  expect(Math.max(...sizes)).toBe(3);
});

test('missing batch results cannot be acknowledged', async () => {
  const batch = createAwaitedKeyBatch({ execute: () => [] });
  await expect(batch.enqueue('a', 1)).rejects.toThrow(/Incomplete/);
});
