import mongoose from "mongoose";
import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import { deleteBusinessSafely } from "../../src/services/businessDeletion.service.js";
import Business from "../../src/models/business.js";
import User from "../../src/models/user.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import Connection from "../../src/models/integrationConnection.js";
import Intent from "../../src/models/integrationDisconnectIntent.js";
import { encryptSecret } from "../../src/services/integrations/tokenEncryption.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
let originalFetch;
beforeAll(connectTestDB, 60000);
beforeEach(() => {
  originalFetch = global.fetch;
  process.env.INTEGRATION_ENCRYPTION_KEY =
    "pilot-encryption-key-with-at-least-32-characters";
});
afterEach(async () => {
  global.fetch = originalFetch;
  await clearTestDB();
});
afterAll(closeTestDB);
test("H04 erases every tenant collection including unknown future children and isolates another tenant", async () => {
  const a = await stabilizationFixture(),
    b = await stabilizationFixture();
  await Message.create({
    business: a.business._id,
    conversation: a.conversation._id,
    direction: "inbound",
    body: "Synthetic private text",
    from: a.lead.phone,
    to: "+15555550123",
  });
  await mongoose.connection.collection("pilot_future_children").insertMany([
    { business: a.business._id, privateValue: "Synthetic A" },
    { business: b.business._id, privateValue: "Synthetic B" },
  ]);
  await deleteBusinessSafely({ businessId: a.business._id });
  expect(await Business.findById(a.business._id)).toBeNull();
  expect(await User.findById(a.user._id)).toBeNull();
  expect(await Lead.countDocuments({ business: a.business._id })).toBe(0);
  expect(await Message.countDocuments({ business: a.business._id })).toBe(0);
  expect(
    await mongoose.connection
      .collection("pilot_future_children")
      .countDocuments({ business: a.business._id }),
  ).toBe(0);
  expect(await Lead.findById(b.lead._id)).not.toBeNull();
  expect(await User.findById(b.user._id)).not.toBeNull();
});
test("H04 failed Google revoke prevents final erasure and resumes after its durable receipt is verified", async () => {
  const a = await stabilizationFixture();
  await Connection.create({
    business: a.business._id,
    provider: "google_calendar",
    status: "connected",
    refreshTokenEncrypted: encryptSecret("synthetic-refresh"),
  });
  global.fetch = jest.fn(async () => {
    throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
  });
  await expect(
    deleteBusinessSafely({ businessId: a.business._id }),
  ).rejects.toMatchObject({ code: "BUSINESS_DELETION_GOOGLE_PENDING" });
  expect(
    (await Business.findById(a.business._id)).accountLifecycle.status,
  ).toBe("deleting");
  expect(await Lead.findById(a.lead._id)).not.toBeNull();
  const intent = await Intent.findOne({ business: a.business._id });
  await Intent.updateOne(
    { _id: intent._id },
    { $set: { nextAttemptAt: new Date(0) } },
  );
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
  const { processGoogleDisconnectIntent } =
    await import("../../src/services/integrations/googleDisconnect.service.js");
  expect(
    await processGoogleDisconnectIntent({
      id: intent._id,
      businessId: a.business._id,
    }),
  ).toBe(true);
  await deleteBusinessSafely({ businessId: a.business._id });
  expect(await Business.findById(a.business._id)).toBeNull();
  expect(await Connection.countDocuments({ business: a.business._id })).toBe(0);
});
test("H04 removes hashed tenant budget children without refunding fleet spend or touching another tenant", async () => {
  const a = await stabilizationFixture(),
    b = await stabilizationFixture();
  const { reserveProviderBudget } =
    await import("../../src/services/budgets/providerBudget.service.js");
  const Counter = (await import("../../src/models/providerBudgetCounter.js"))
    .default;
  const Reservation = (
    await import("../../src/models/providerBudgetReservation.js")
  ).default;
  const crypto = await import("node:crypto");
  const scope = (id) =>
    crypto.createHash("sha256").update(`pilot:${id}`).digest("hex");
  for (const item of [a, b])
    await reserveProviderBudget({
      businessId: item.business._id,
      metric: "sms",
      key: "erasure-synthetic",
      amount: 1,
    });
  expect(await Reservation.countDocuments()).toBe(2);
  await deleteBusinessSafely({ businessId: a.business._id });
  expect(
    await Reservation.countDocuments({ scope: scope(a.business._id) }),
  ).toBe(0);
  expect(
    await Counter.countDocuments({
      _id: { $regex: `^${scope(a.business._id)}:` },
    }),
  ).toBe(0);
  expect(
    await Reservation.countDocuments({ scope: scope(b.business._id) }),
  ).toBe(1);
  const fleet = await Counter.find({ _id: { $regex: "^fleet:sms:" } }).lean();
  expect(fleet).toHaveLength(2);
  expect(fleet.every((row) => row.used === 2)).toBe(true);
  expect(await Business.findById(b.business._id)).not.toBeNull();
});
