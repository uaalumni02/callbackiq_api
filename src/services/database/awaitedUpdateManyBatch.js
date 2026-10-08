import { sameTurnBatch } from './sameTurnBatch.js';
// For ingress bookkeeping whose caller only awaits completion. Only used for
// AutomationJob/CallLog, which have no custom updateMany middleware. Mongoose
// bulkWrite still casts each operation and applies each model's timestamps.
// Never use aggregate bulk counts as an individual operation's match count.
export function awaitedUpdateManyBatch(Model, name) {
  return sameTurnBatch(async operations => {
    if (operations.length === 1) {
      const { filter, update } = operations[0];
      return [await Model.updateMany(filter, update)];
    }
    await Model.bulkWrite(operations.map(operation => ({ updateMany: operation })), { ordered: false });
    return operations.map(() => undefined);
  }, { name });
}
