import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';

const transactions = new AsyncLocalStorage();
const methods = new Set(['updateOne', 'updateMany', 'findOneAndUpdate']);
/** Transaction/session lifetime is owned here; domain commands receive no Mongo session. */
export function withRequestStateTransaction(command, { guardAtCommit = false } = {}) {
  return mongoose.connection.transaction(session => transactions.run({ session, wrote: false }, async () => {
    const result = await command();
    // A replay that returned before writing previously skipped the final fence.
    if (guardAtCommit && transactions.getStore().wrote) assertDistributedLeaseActive();
    return result;
  }));
}

/** Bind reads to the current attempt, including MongoDB's automatic transaction retries. */
export function requestStateRead(query) {
  return query.session(transactions.getStore()?.session || null);
}

/** Preserve an explicit legacy session, otherwise inherit the owning transition transaction. */
export function requestStateOptions(explicitSession) {
  const session = explicitSession || transactions.getStore()?.session;
  return session ? { session } : {};
}

/** @param {{model:object, method:'updateOne'|'updateMany'|'findOneAndUpdate', filter:object, changes:object, options?:object}} input */
export function requestStateWrite({ model, method, filter, changes, options = {} }) {
  if (!methods.has(method)) throw new TypeError(`Unsupported request-state write: ${method}`);
  const transaction = transactions.getStore();
  if (transaction) transaction.wrote = true;
  return model[method](filter, changes, { ...options, ...requestStateOptions() });
}
