const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const allowedUpdates = new Set(['$set', '$unset', '$inc', '$min', '$max']);

const invalid = message => Object.assign(new TypeError(message), { code: 'INVALID_CONDITIONAL_WRITE' });

function validateIdentity(model, identity) {
  if (!identity?._id || Object.keys(identity).some(key => !['_id', 'business'].includes(key))) {
    throw invalid('Conditional completion requires an exact document identity');
  }
  if (model.schema.path('business') && !identity.business) {
    throw invalid('Tenant-owned completion requires its business identity');
  }
  for (const value of Object.values(identity)) {
    if (!value || (typeof value !== 'string' && typeof value.toHexString !== 'function')) {
      throw invalid('Document identity must contain IDs, never query selectors');
    }
  }
}

function observationFilters(observed) {
  if (!observed || !Object.keys(observed).length) throw invalid('An observed state is required');
  return Object.entries(observed).map(([field, value]) => {
    if (!fieldPattern.test(field) || ['_id', 'business'].includes(field)) {
      throw invalid('Observation must name state fields, not identity or operators');
    }
    if (value && typeof value === 'object' && !(value instanceof Date) && typeof value.toHexString !== 'function') {
      throw invalid('Observed values must be scalar values, Dates or ObjectIds');
    }
    return { [field]: value === undefined ? { $exists: false } : { $eq: value } };
  });
}

function validateUpdate(update) {
  const operators = Object.keys(update || {});
  if (!operators.length || operators.some(key => !allowedUpdates.has(key))) {
    throw invalid('Completion changes require supported atomic update operators');
  }
  for (const changes of Object.values(update)) {
    for (const field of Object.keys(changes || {})) {
      if (!fieldPattern.test(field) || /^(?:_id|business)(?:\.|$)/.test(field)) {
        throw invalid('A completion cannot move its document or tenant identity');
      }
    }
  }
}

/**
 * Complete work only against the state it observed. A rejected completion always
 * reloads the same scoped identity; callers must inspect applied before effects.
 * This intentionally cannot upsert, broaden identity, or move tenant ownership.
 */
export async function conditionalWrite({ model, identity, observed, update, select, session }) {
  validateIdentity(model, identity);
  const conditions = observationFilters(observed);
  validateUpdate(update);
  const query = model.findOneAndUpdate({ $and: [identity, ...conditions] }, update,
    { returnDocument: 'after', runValidators: true, ...(session ? { session } : {}) });
  const current = await (select ? query.select(select) : query);
  if (current) return { applied: true, current };
  const reload = model.findOne(identity);
  if (session) reload.session(session);
  return { applied: false, current: await (select ? reload.select(select) : reload) };
}
