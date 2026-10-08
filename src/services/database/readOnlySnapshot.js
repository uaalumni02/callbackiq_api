// Read-only ingress results still use Mongoose queries, casting, write validators,
// middleware and atomic predicates. Avoid allocating change-tracked documents
// when the caller only reads/serializes the result. Never use this for save().
const datePaths = new WeakMap();
function normalizeDefaultDates(value, schema) {
  if (!value || !schema) return;
  let paths = datePaths.get(schema);
  if (!paths) {
    paths = Object.values(schema.paths).filter(type => type.instance === "Date" || type.schema)
      .map(type => ({ parts: type.path.split("."), type }));
    datePaths.set(schema, paths);
  }
  for (const { parts, type } of paths) {
    let parent = value;
    for (const part of parts.slice(0, -1)) parent = parent?.[part];
    if (!parent) continue;
    const key = parts[parts.length - 1], field = parent[key];
    // applyDefaults deliberately skips casting; Date.now defaults need Date
    // instances to preserve the JSON representation of hydrated legacy rows.
    if (type.instance === "Date" && typeof field === "number") parent[key] = new Date(field);
    else if (type.schema && Array.isArray(field)) field.forEach(item => normalizeDefaultDates(item, type.schema));
    else if (type.schema) normalizeDefaultDates(field, type.schema);
  }
}
function minimizeSnapshot(value) {
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (field?.constructor === Object) {
      minimizeSnapshot(field);
      if (!Object.keys(field).length) delete value[key];
    } else if (Array.isArray(field)) {
      for (const item of field) if (item?.constructor === Object) minimizeSnapshot(item);
    }
  }
}
export function withSnapshotDefaults(Model, value) {
  if (value == null) return value;
  Model.applyDefaults(value);
  normalizeDefaultDates(value, Model.schema);
  // Match the existing schemas' default toJSON/toObject minimize behavior.
  minimizeSnapshot(value);
  return value;
}
export async function readOnlySnapshot(Model, query, enabled = true) {
  if (!enabled) return query;
  // The fallback supports existing adapters/test doubles returning a promise.
  // Native Mongoose queries always take the lean branch.
  if (typeof query?.lean !== "function") return query;
  const value = await query.lean();
  return withSnapshotDefaults(Model, value);
}
