import Message from '../../models/message.js';
import { createAwaitedKeyBatch } from '../database/awaitedKeyBatch.js';
import { withMessageInsertDefaults } from '../database/messageInsertDefaults.js';

const identity = filter => `${filter.business}:${filter.providerMessageId}`;
const execute = async rows => {
  if (rows.length === 1) {
    const row = rows[0];
    const result = await Message.findOneAndUpdate(row.filter, row.update, row.options).lean();
    if (!result) throw new Error('Inbound SMS persistence returned no message');
    return [result];
  }
  await Message.bulkWrite(rows.map(row => ({ updateOne: {
    filter: row.filter, update: row.update, upsert: true, setDefaultsOnInsert: false,
  } })), { ordered: false });
  const persisted = await Message.find({ $or: rows.map(row => row.filter) }).lean();
  const byIdentity = new Map(persisted.map(row => [identity({ business: row.business, providerMessageId: row.providerMessageId }), row]));
  return rows.map(row => {
    const result = byIdentity.get(identity(row.filter));
    if (!result) throw new Error('Incomplete inbound SMS persistence readback');
    return result;
  });
};
const batch = createAwaitedKeyBatch({ execute });

export const smsIngressPersistenceDiagnostics = () => batch.diagnostics();

export function persistInboundSmsMessage(filter, update, options) {
  // Compatibility for existing mocked models and any nonstandard future call.
  // Normal production calls only use the business+provider SID unique index.
  const supported = filter.business && filter.providerMessageId &&
    Object.keys(filter).every(key => ['business', 'providerMessageId'].includes(key)) &&
    options?.upsert === true && options.returnDocument === 'after' &&
    options.setDefaultsOnInsert === true &&
    Object.keys(options).every(key => ['upsert', 'returnDocument', 'setDefaultsOnInsert'].includes(key)) &&
    typeof Message.bulkWrite === 'function';
  const prepared = supported ? withMessageInsertDefaults(Message, filter, update) : null;
  if (!prepared) return Message.findOneAndUpdate(filter, update, options);
  const persisted = batch.enqueue(identity(filter), {
    filter, update: prepared, options: { ...options, setDefaultsOnInsert: false },
  });
  // Earlier snapshot helpers call query.lean() or query.lean().exec(). The
  // batch already returns a plain persisted record; both remain idempotent.
  persisted.lean = () => persisted;
  persisted.exec = () => persisted;
  return persisted;
}
