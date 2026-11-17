import { updatePrivilegedRecord, deletePrivilegedRecord } from '../../../services/stateTransitions/tenantRecords.js';
import mongoose from 'mongoose';
import User from '../../../models/user.js';
import logger from '../../../config/logger.js';
const denied = () => Object.assign(new Error('Fresh administrator authority and a named operation are required.'), {
  code: 'PRIVILEGED_ACCESS_DENIED',
  statusCode: 403
});
const resources = new Set(['Lead', 'Conversation', 'CallLog', 'Alert', 'ConversationIntelligence', 'Message', 'SupportTicket']);
async function authorized({
  model,
  id,
  actorId,
  reason
}) {
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(actorId) || !/^[A-Z][A-Z0-9_]{3,79}$/.test(String(reason || ''))) throw denied();
  if (!resources.has(model.modelName) || !model.schema.path('business')) throw denied();
  const actor = await User.findById(actorId).select('_id role').lean();
  if (actor?.role !== 'admin') throw denied();
  logger.info('repository.privileged_access', {
    actorId: new mongoose.Types.ObjectId(actorId),
    resourceId: new mongoose.Types.ObjectId(id),
    resourceType: model.modelName,
    operationCode: reason
  });
}
/** Explicit global operations: authority is reloaded for every operation, never cached.
 * Owner-facing repositories do not re-export these capabilities. */
export async function adminReadById(input) {
  await authorized(input);
  const query = input.model.findById(input.id).setOptions({ allowCrossTenant: true });
  for (const spec of input.populate || []) query.populate(spec);
  if (input.select) query.select(input.select);
  return query.lean();
}
export async function adminUpdateById(input) {
  await authorized(input);
  const query = updatePrivilegedRecord({ input }).setOptions({ allowCrossTenant: true });
  for (const spec of input.populate || []) query.populate(spec);
  return query.lean();
}
export async function adminDeleteById(input) {
  await authorized(input);
  return deletePrivilegedRecord({ input }).setOptions({ allowCrossTenant: true });
}
