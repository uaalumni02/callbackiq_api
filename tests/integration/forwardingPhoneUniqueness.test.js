import mongoose from "mongoose";
import Business from "../../src/models/business.js";
import TrialRedemption from "../../src/models/trialRedemption.js";
import { getTrialEligibility } from "../../src/helpers/billing/trial.js";
import { migrateForwardingPhones } from "../../src/services/forwardingPhoneMigration.service.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
  await Business.init();
}, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
const payload = (extra = {}) => ({
  owner: new mongoose.Types.ObjectId(), businessName: "Shared Business Name",
  forwardingPhone: "4045551234", isActive: true, ...extra,
});

test("concurrent businesses cannot claim different formats of the same active phone", async () => {
  const outcomes = await Promise.allSettled([
    Business.create(payload()),
    Business.create(payload({ forwardingPhone: "(404) 555-1234" })),
  ]);
  expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
  const failure = outcomes.find(x => x.status === "rejected");
  expect(failure.reason).toMatchObject({ code: 11000, keyPattern: { forwardingPhone: 1 } });
  expect(await Business.countDocuments({ forwardingPhone: "+14045551234" })).toBe(1);
});

test("same-name businesses with distinct phones and multiple unfinished empty phones are allowed", async () => {
  const records = await Business.create([
    payload(), payload({ forwardingPhone: "4045555678" }),
    payload({ forwardingPhone: "" }), payload({ forwardingPhone: "" }),
  ]);
  expect(records).toHaveLength(4);
});

test("saving the current number is safe; bulk updates and reactivation cannot take another claim", async () => {
  const active = await Business.create(payload());
  const inactive = await Business.create(payload({ isActive: false }));
  await expect(Business.findByIdAndUpdate(active._id, { forwardingPhone: "(404) 555-1234" })).resolves.toBeTruthy();
  await expect(Business.findByIdAndUpdate(inactive._id, { isActive: true })).rejects.toMatchObject({ code: 11000 });
  const other = await Business.create(payload({ forwardingPhone: "4045555678" }));
  await expect(Business.updateMany({ _id: other._id }, { $set: { forwardingPhone: "4045551234" } })).rejects.toMatchObject({ code: 11000 });
});

test("reusing an inactive routing number does not reset its free trial history", async () => {
  const old = await Business.create(payload({ isActive: false }));
  const redemption = await TrialRedemption.create({
    business: old._id, owner: old.owner, emailKey: "old@example.test", phoneKey: old.forwardingPhone,
  });
  const next = await Business.create(payload({ email: "new@example.test" }));
  expect(await getTrialEligibility({ business: next, ownerId: next.owner })).toMatchObject({
    eligible: false, reason: "trial_already_used",
  });
  expect(await TrialRedemption.findById(redemption._id)).toBeTruthy();
});

test("migration normalizes existing records, preserves verification, and builds an idempotent unique index", async () => {
  const collection = mongoose.connection.db.collection("forwarding_migration_clean");
  const verifiedAt = new Date("2026-11-01T12:00:00Z");
  await collection.insertMany([
    { forwardingPhone: "(404) 555-1234", forwardingPhoneVerifiedAt: verifiedAt, forwardingPhoneVerifiedValue: "+14045551234" },
    { forwardingPhone: "4045551234", isActive: false },
    { forwardingPhone: "", isActive: true },
    { forwardingPhone: "", isActive: true },
  ]);
  const before = await migrateForwardingPhones(collection);
  expect(before).toMatchObject({ blocked: false, ready: false, normalizationCount: 2, indexStatus: "missing" });
  expect((await collection.findOne({ forwardingPhoneVerifiedAt: verifiedAt })).forwardingPhone).toBe("(404) 555-1234");
  expect(await migrateForwardingPhones(collection, { apply: true })).toMatchObject({ ready: true, applied: 2 });
  expect(await collection.findOne({ forwardingPhoneVerifiedAt: verifiedAt })).toMatchObject({
    forwardingPhone: "+14045551234", isActive: true, forwardingPhoneVerifiedValue: "+14045551234",
  });
  expect(await migrateForwardingPhones(collection, { apply: true })).toMatchObject({ ready: true, applied: 0 });
  await expect(collection.insertOne({ forwardingPhone: "+14045551234", isActive: true })).rejects.toMatchObject({ code: 11000 });
  await collection.drop();
});

test("migration leaves every record unchanged when normalized active duplicates exist", async () => {
  const collection = mongoose.connection.db.collection("forwarding_migration_duplicate");
  await collection.insertMany([{ forwardingPhone: "4045551234", isActive: true }, { forwardingPhone: "(404) 555-1234" }]);
  const before = await collection.find({}).toArray();
  const result = await migrateForwardingPhones(collection, { apply: true });
  expect(result).toMatchObject({ blocked: true, ready: false });
  expect(result.duplicates[0].businessIds).toHaveLength(2);
  expect(await collection.find({}).toArray()).toEqual(before);
  expect((await collection.indexes()).some(index => index.unique)).toBe(false);
  await collection.drop();
});
