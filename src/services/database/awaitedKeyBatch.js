// Bounded, awaited batching. One operation per identity can be in flight;
// callers retain ownership of error handling and do not finish before commit.
export function createAwaitedKeyBatch({ execute, maxBatchSize = 64, maxQueued = 4096, maxConcurrent = 2 }) {
  const queues = new Map();
  const busy = new Set();
  let queued = 0;
  let running = 0;
  let scheduled = false;
  const diagnostics = { requests: 0, batches: 0, largestBatch: 0, failedBatches: 0, rejected: 0 };
  const schedule = () => {
    if (scheduled || running >= maxConcurrent || queued === 0) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  };
  const pump = () => {
    while (running < maxConcurrent) {
      const batch = [];
      for (const [key, queue] of queues) {
        if (busy.has(key)) continue;
        const row = queue.shift();
        queued--;
        if (!queue.length) queues.delete(key);
        busy.add(key);
        batch.push(row);
        if (batch.length >= maxBatchSize) break;
      }
      if (!batch.length) return;
      running++;
      diagnostics.batches++;
      diagnostics.largestBatch = Math.max(diagnostics.largestBatch, batch.length);
      Promise.resolve().then(() => execute(batch.map(row => row.value))).then(async results => {
        if (!Array.isArray(results) || results.length !== batch.length) throw new Error('Incomplete SMS persistence batch result');
        // Large completions otherwise queue every ingress continuation as one
        // microtask burst, delaying socket acceptance and lease heartbeats.
        for (let i = 0; i < batch.length; i++) {
          batch[i].resolve(results[i]);
          if ((i + 1) % 8 === 0 && i + 1 < batch.length) {
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      }).catch(error => {
        diagnostics.failedBatches++;
        // A partial/uncertain database write is never acknowledged as success.
        // Each webhook's normal failure path leaves it available for retry.
        batch.forEach(row => row.reject(error));
      }).finally(() => {
        running--;
        batch.forEach(row => busy.delete(row.key));
        schedule();
      });
    }
  };
  return {
    enqueue(key, value) {
      diagnostics.requests++;
      if (queued >= maxQueued) {
        diagnostics.rejected++;
        return Promise.reject(Object.assign(new Error('SMS persistence queue is full; retry the webhook'), { code: 'SMS_INGRESS_QUEUE_FULL' }));
      }
      return new Promise((resolve, reject) => {
        const queue = queues.get(key) || [];
        queue.push({ key, value, resolve, reject });
        queues.set(key, queue);
        queued++;
        schedule();
      });
    },
    diagnostics: () => ({ ...diagnostics, queued, running }),
  };
}
