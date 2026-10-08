import { createAwaitedKeyBatch } from './awaitedKeyBatch.js';

// Used only by Alert, ConversionEvent and WebhookEvent: these concrete schemas
// have no custom save hooks. Mongoose still casts, validates, applies defaults
// and timestamps. Indexed duplicate errors preserve each caller's outcome.
export function createAwaitedInsertBatch(Model) {
  const batch = createAwaitedKeyBatch({ maxConcurrent: 4, execute: async values => {
    if (values.length === 1) {
      try { return [{ value: await Model.create(values[0]) }]; }
      catch (error) { return [{ error }]; }
    }
    const outcomes = values.map(() => null);
    const valid = [];
    await Promise.all(values.map(async (value, index) => {
      try {
        const document = new Model(value);
        await document.validate();
        document.initializeTimestamps();
        const versionKey = Model.schema.options.versionKey;
        if (versionKey) document.set(versionKey, 0);
        const prepared = document.toObject({ depopulate: true, transform: false,
          virtuals: false, getters: false });
        valid.push({ document, prepared, index });
      } catch (error) { outcomes[index] = { error }; }
    }));
    if (!valid.length) return outcomes;
    // Keep original request order for write-error index attribution.
    valid.sort((a, b) => a.index - b.index);
    try {
      // Every prepared row has already been cast, defaulted and validated once.
      // The public lean option avoids repeating all document validation while
      // retaining insertMany middleware and the driver's indexed error results.
      await Model.insertMany(valid.map(row => row.prepared), { ordered: false, lean: true });
      valid.forEach(row => { row.document.$isNew = false; outcomes[row.index] = { value: row.document }; });
    } catch (error) {
      const writes = (error.writeErrors || []).map(e => ({ ...(e.err || e), index: e.index ?? e.err?.index }));
      const concern = error.result?.getWriteConcernError?.();
      // Only indexed duplicate errors prove which other rows committed. Any
      // transport, validation or write-concern uncertainty rejects all rows.
      if (!writes.length || concern || writes.some(e => e.code !== 11000 || !Number.isInteger(e.index) || e.index < 0 || e.index >= valid.length) ||
          error.result?.insertedCount !== valid.length - writes.length) throw error;
      const failures = new Map(writes.map(e => [e.index, e]));
      valid.forEach((row, i) => { if (!failures.has(i)) row.document.$isNew = false; outcomes[row.index] = failures.has(i)
        ? { error: Object.assign(new Error(failures.get(i).errmsg || 'Duplicate key'), { code: 11000 }) }
        : { value: row.document }; });
    }
    return outcomes;
  } });
  let next = 0;
  const insert = async payload => {
    if (!Model.schema || typeof Model.insertMany !== 'function') return Model.create(payload);
    const result = await batch.enqueue(String(next++), payload);
    if (result.error) throw result.error;
    return result.value;
  };
  insert.diagnostics = batch.diagnostics;
  return insert;
}
