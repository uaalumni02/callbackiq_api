// Compare semantics, not names. Reordered compound keys are different indexes.
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export const sameIndexKey = (a, b) => JSON.stringify(Object.entries(a || {})) === JSON.stringify(Object.entries(b || {}));
export const indexOptionsMatch = (actual, required = {}) => {
  for (const key of ["unique", "sparse"]) if (Boolean(actual[key]) !== Boolean(required[key])) return false;
  for (const key of ["expireAfterSeconds", "partialFilterExpression", "collation"]) {
    if (JSON.stringify(canonical(actual[key] ?? null)) !== JSON.stringify(canonical(required[key] ?? null))) return false;
  }
  return true;
};
export const inspectRequiredIndex = (indexes, definition) => {
  const matchingKeys = indexes.filter(index => sameIndexKey(index.key, definition.key));
  if (matchingKeys.some(index => indexOptionsMatch(index, definition.options))) return "ok";
  return matchingKeys.length ? "conflict" : "missing";
};
