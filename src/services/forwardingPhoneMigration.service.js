import { normalizePhoneToE164 } from "../voice/voicePhone.service.js";
import { FORWARDING_PHONE_INDEX_OPTIONS } from "../helpers/forwardingPhonePolicy.js";
import { inspectRequiredIndex, sameIndexKey } from "./requiredIndexes.service.js";

export function planForwardingPhoneMigration(businesses) {
  const claims = new Map();
  const changes = [];
  const invalidBusinessIds = [];
  for (const business of businesses) {
    const raw = String(business.forwardingPhone || "").trim();
    const phone = normalizePhoneToE164(raw);
    if (raw && !phone) {
      invalidBusinessIds.push(String(business._id));
      continue;
    }
    const active = business.isActive !== false;
    if (active && phone) {
      const ids = claims.get(phone) || [];
      ids.push(String(business._id));
      claims.set(phone, ids);
    }
    if (business.forwardingPhone !== (phone || "") || typeof business.isActive !== "boolean") {
      changes.push({
        businessId: business._id,
        previousPhone: business.forwardingPhone,
        previousActive: business.isActive,
        forwardingPhone: phone || "",
        isActive: active,
      });
    }
  }
  const duplicates = [...claims].filter(([, ids]) => ids.length > 1)
    .map(([phone, businessIds]) => ({ phoneLast4: phone.slice(-4), businessIds }));
  return { changes, invalidBusinessIds, duplicates };
}

const definition = {
  key: { forwardingPhone: 1 },
  options: FORWARDING_PHONE_INDEX_OPTIONS,
};

export async function migrateForwardingPhones(collection, { apply = false } = {}) {
  const readPlan = async () => planForwardingPhoneMigration(await collection.find({}, {
    projection: { _id: 1, forwardingPhone: 1, isActive: 1 },
  }).toArray());
  const plan = await readPlan();
  let indexes = [];
  try { indexes = await collection.indexes(); } catch (error) { if (error.code !== 26) throw error; }
  const conflictingName = indexes.some(index =>
    index.name === FORWARDING_PHONE_INDEX_OPTIONS.name && !sameIndexKey(index.key, definition.key));
  const indexStatus = conflictingName ? "conflict" : inspectRequiredIndex(indexes, definition);
  const blocked = plan.duplicates.length > 0 || plan.invalidBusinessIds.length > 0 || indexStatus === "conflict";
  const summary = {
    mode: apply ? "apply" : "check",
    blocked,
    normalizationCount: plan.changes.length,
    duplicates: plan.duplicates,
    invalidBusinessIds: plan.invalidBusinessIds,
    indexStatus,
    ready: !blocked && plan.changes.length === 0 && indexStatus === "ok",
  };
  if (!apply || blocked) return summary;

  for (const change of plan.changes) {
    const filter = {
      _id: change.businessId,
      forwardingPhone: change.previousPhone === undefined ? { $exists: false } : change.previousPhone,
      isActive: change.previousActive === undefined ? { $exists: false } : change.previousActive,
    };
    const result = await collection.updateOne(filter, { $set: {
      forwardingPhone: change.forwardingPhone,
      isActive: change.isActive,
    } });
    if (result.matchedCount !== 1) throw new Error("A business changed during migration. Pause business writes and rerun the check.");
  }
  const after = await readPlan();
  if (after.changes.length || after.duplicates.length || after.invalidBusinessIds.length) {
    throw new Error("Forwarding-phone data changed during migration. Pause business writes and rerun the check.");
  }
  if (indexStatus !== "ok") await collection.createIndex(definition.key, definition.options);
  return { ...summary, ready: true, indexStatus: "ok", applied: plan.changes.length };
}
