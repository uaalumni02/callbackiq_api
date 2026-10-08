// Share one round trip among work already pending in this process. This is not
// a cache: every batch executes a new read/write and every caller awaits it.
const diagnostics = new Map();
export const databaseBatchDiagnostics = () => Object.fromEntries(
  [...diagnostics].map(([name, value]) => [name, { ...value }]),
);
export function sameTurnBatch(execute, { maximum = 64, name = "unnamed" } = {}) {
  const stats = { requests: 0, batches: 0, largestBatch: 0, failedBatches: 0 };
  if (name !== "unnamed") diagnostics.set(name, stats);
  let pending = [];
  let scheduled = null;
  const flush = () => {
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    stats.batches++;
    stats.largestBatch = Math.max(stats.largestBatch, batch.length);
    Promise.resolve().then(() => execute(batch.map(item => item.value)))
      .then(results => {
        if (!Array.isArray(results) || results.length !== batch.length) {
          throw new Error('Database batch returned an invalid result count');
        }
        batch.forEach((item, index) => item.resolve(results[index]));
      })
      .catch(error => { stats.failedBatches++; batch.forEach(item => item.reject(error)); });
  };
  return value => new Promise((resolve, reject) => {
    stats.requests++;
    pending.push({ value, resolve, reject });
    if (pending.length >= maximum) flush();
    else if (!scheduled) scheduled = setImmediate(flush);
  });
}
