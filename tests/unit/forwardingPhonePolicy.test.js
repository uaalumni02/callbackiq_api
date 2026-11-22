import {
  forwardingPhoneConflictQuery, isForwardingPhoneDuplicate, normalizeForwardingPhone,
  FORWARDING_PHONE_INDEX,
} from "../../src/helpers/forwardingPhonePolicy.js";
import { planForwardingPhoneMigration, migrateForwardingPhones } from "../../src/services/forwardingPhoneMigration.service.js";

test.each(["4045551234", "(404) 555-1234", "+1 404 555 1234"])("canonicalizes %s", value => {
  expect(normalizeForwardingPhone(value)).toBe("+14045551234");
});
test("conflict lookup excludes the current business and inactive records", () => {
  expect(forwardingPhoneConflictQuery("4045551234", "mine")).toMatchObject({
    _id: { $ne: "mine" }, isActive: { $ne: false },
    forwardingPhone: { $in: expect.arrayContaining(["+14045551234", "4045551234"]) },
  });
});
test.each([
  [{ code: 11000, keyPattern: { forwardingPhone: 1 } }, true],
  [{ code: 11000, keyValue: { forwardingPhone: "+14045551234" } }, true],
  [{ code: 11000, message: `index: ${FORWARDING_PHONE_INDEX}` }, true],
  [{ code: 11000, keyPattern: { email: 1 } }, false],
  [{ code: 11000, keyPattern: { phone: 1 } }, false],
  [{ code: 500, keyPattern: { forwardingPhone: 1 } }, false],
  [null, false],
])("classifies duplicate-key errors without exposing their values: %j", (error, expected) => {
  expect(isForwardingPhoneDuplicate(error)).toBe(expected);
});
test("preflight groups format variants, ignores inactive claims, and reports invalid data", () => {
  const plan = planForwardingPhoneMigration([
    { _id: "a", forwardingPhone: "4045551234", isActive: true },
    { _id: "b", forwardingPhone: "(404) 555-1234" },
    { _id: "c", forwardingPhone: "+14045551234", isActive: false },
    { _id: "d", forwardingPhone: "unknown", isActive: true },
    { _id: "e", forwardingPhone: "", isActive: true },
  ]);
  expect(plan.duplicates).toEqual([{ phoneLast4: "1234", businessIds: ["a", "b"] }]);
  expect(plan.invalidBusinessIds).toEqual(["d"]);
  expect(plan.changes.map(x => x.businessId)).toEqual(["a", "b"]);
});
const collection = rows => ({
  find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(rows) }),
  indexes: jest.fn().mockResolvedValue([]),
  updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
  createIndex: jest.fn().mockResolvedValue(FORWARDING_PHONE_INDEX),
});
test("check mode never writes or builds an index", async () => {
  const db = collection([{ _id: "a", forwardingPhone: "4045551234", isActive: true }]);
  expect(await migrateForwardingPhones(db)).toMatchObject({ blocked: false, ready: false, normalizationCount: 1 });
  expect(db.updateOne).not.toHaveBeenCalled();
  expect(db.createIndex).not.toHaveBeenCalled();
});
test("apply refuses all mutations when active duplicates exist", async () => {
  const db = collection([
    { _id: "a", forwardingPhone: "4045551234", isActive: true },
    { _id: "b", forwardingPhone: "+14045551234", isActive: true },
  ]);
  expect(await migrateForwardingPhones(db, { apply: true })).toMatchObject({ blocked: true, ready: false });
  expect(db.updateOne).not.toHaveBeenCalled();
  expect(db.createIndex).not.toHaveBeenCalled();
});
test("apply refuses invalid numbers and incompatible existing indexes", async () => {
  const invalid = collection([{ _id: "a", forwardingPhone: "invalid", isActive: true }]);
  const incompatible = collection([]);
  incompatible.indexes.mockResolvedValue([{ key: { forwardingPhone: 1 } }]);
  for (const db of [invalid, incompatible]) {
    expect(await migrateForwardingPhones(db, { apply: true })).toMatchObject({ blocked: true, ready: false });
    expect(db.updateOne).not.toHaveBeenCalled();
    expect(db.createIndex).not.toHaveBeenCalled();
  }
});
test("a concurrent edit stops migration rather than overwriting it", async () => {
  const db = collection([{ _id: "a", forwardingPhone: "4045551234", isActive: true }]);
  db.updateOne.mockResolvedValue({ matchedCount: 0 });
  await expect(migrateForwardingPhones(db, { apply: true })).rejects.toThrow("changed during migration");
  expect(db.createIndex).not.toHaveBeenCalled();
});
