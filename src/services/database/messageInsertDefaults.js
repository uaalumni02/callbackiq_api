// Materialize the same Message defaults once, then use a path set instead of
// rescanning every update key for every default. Kept local to inbound messages;
// no Mongoose configuration or other model's insertion behavior is changed.
const plans = new WeakMap();
const ancestors = (path) => {
  const pieces = path.split('.');
  return pieces.map((_, i) => pieces.slice(0, i + 1).join('.'));
};
const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

export function withMessageInsertDefaults(model, filter, update) {
  if (typeof model?.applyDefaults !== 'function' || !model.schema ||
      Object.keys(update).some(key => !['$set', '$setOnInsert'].includes(key))) return null;
  let plan = plans.get(model.schema);
  if (!plan) {
    plan = [];
    model.schema.eachPath((path, type) => {
      if ((path === '_id' && type.options.auto) || path.includes('$*')) return;
      plan.push({ path, prefixes: ancestors(path) });
    });
    plans.set(model.schema, plan);
  }
  const touched = new Set();
  const parents = new Set();
  const mark = (path) => {
    touched.add(path);
    for (const prefix of ancestors(path)) parents.add(prefix);
  };
  for (const [path, value] of Object.entries(filter)) {
    if (path.startsWith('$') || (value && typeof value === 'object' &&
        Object.keys(value).some(key => key.startsWith('$')))) continue;
    mark(path);
  }
  for (const fields of Object.values(update)) for (const path of Object.keys(fields)) mark(path);
  // Message defaults do not depend on query context. This public API also
  // evaluates nested defaults and allocates fresh arrays/objects per request.
  const defaults = model.applyDefaults({});
  const insert = { ...update.$setOnInsert };
  for (const { path, prefixes } of plan) {
    if (parents.has(path) || prefixes.some(prefix => touched.has(prefix))) continue;
    const value = getPath(defaults, path);
    if (value !== undefined) insert[path] = value;
  }
  return { ...update, $setOnInsert: insert };
}
