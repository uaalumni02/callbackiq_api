import request from "supertest";
import mongoose from "mongoose";
import app from "../../src/app.js";
import MarketingSource from "../../src/models/marketingSource.js";
import Subscription from "../../src/models/subscription.js";
import User from "../../src/models/user.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

let ownerA;
let ownerB;
let sourceA;
let sourceB;

const register = async (suffix, phone) => {
  const response = await request(app).post("/api/auth/register").send({
    userName: `scopeowner${suffix}`, email: `scope-${suffix}@example.com`,
    password: "Password123", role: "owner", businessName: `Scope Plumbing ${suffix}`,
    businessPhone: phone, businessType: "plumbing", smsConsent: true,
    termsAccepted: true, privacyAccepted: true,
  });
  expect(response.status).toBe(201);
  const data = response.body.data;
  await Subscription.findOneAndUpdate({ business: data.business._id }, {
    $set: { status: "active", isActive: true, currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
  });
  return { token: data.token, business: data.business };
};
const get = (owner, path) => request(app).get(path).set("Authorization", `Bearer ${owner.token}`);

beforeAll(async () => {
  await connectTestDB();
  ownerA = await register("a", "4045551101");
  ownerB = await register("b", "4045551102");
  sourceA = await MarketingSource.create({ business: ownerA.business._id, name: "Private source A", channel: "google_ads" });
  sourceB = await MarketingSource.create({ business: ownerB.business._id, name: "Private source B", channel: "referral" });
}, 60000);

afterAll(async () => {
  await clearTestDB();
  await closeTestDB();
});

test("report resolves implicit and explicit own scope, including uppercase ObjectId text", async () => {
  for (const suffix of ["", `?businessId=${ownerA.business._id}`, `?businessId=${ownerA.business._id.toUpperCase()}`]) {
    const response = await get(ownerA, `/api/marketing-sources/report${suffix}`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body.data)).toContain(String(sourceA._id));
    expect(JSON.stringify(response.body.data)).not.toContain(String(sourceB._id));
  }
});

test("scenario 26: foreign report request is denied, not silently replaced with own report", async () => {
  const response = await get(ownerB, `/api/marketing-sources/report?businessId=${ownerA.business._id}`);
  expect(response.status).toBe(404);
  expect(response.body.success).toBe(false);
  expect(response.body.data).toBeUndefined();
  const own = await get(ownerB, "/api/marketing-sources/report");
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body.data)).toContain(String(sourceB._id));
  expect(JSON.stringify(own.body.data)).not.toContain(String(sourceA._id));
});

test.each(["/api/marketing-sources", "/api/analytics/revenue-recovery/summary", "/api/appointments", "/api/owner/dashboard"])(
  "shared scope rejects foreign and nonexistent businesses at %s", async (path) => {
    for (const id of [ownerA.business._id, String(new mongoose.Types.ObjectId())]) {
      const response = await get(ownerB, `${path}?businessId=${id}`);
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    }
    const own = await get(ownerB, `${path}?businessId=${ownerB.business._id}`);
    expect(own.status).toBe(200);
  },
);

test("foreign write cannot mutate either business; own write still succeeds", async () => {
  const before = await MarketingSource.countDocuments();
  const denied = await request(app).post(`/api/marketing-sources?businessId=${ownerA.business._id}`)
    .set("Authorization", `Bearer ${ownerB.token}`).send({ name: "Forbidden source", channel: "other" });
  expect(denied.status).toBe(404);
  expect(await MarketingSource.countDocuments()).toBe(before);
  const allowed = await request(app).post(`/api/marketing-sources?businessId=${ownerB.business._id}`)
    .set("Authorization", `Bearer ${ownerB.token}`).send({ name: "Allowed source", channel: "other" });
  expect(allowed.status).toBe(201);
  expect(String((await MarketingSource.findOne({ name: "Allowed source" })).business)).toBe(ownerB.business._id);
});

test.each(["malformed", "duplicate"])(
  "malformed scope produces a controlled client error: %s", async (kind) => {
    const query = kind === "malformed" ? "businessId=bad-id"
      : `businessId=${ownerA.business._id}&businessId=${ownerB.business._id}`;
    const response = await get(ownerB, `/api/marketing-sources/report?${query}`);
    expect(response.status).toBe(400);
    expect(response.body.data).toBeUndefined();
  },
);

test("missing authentication is rejected", async () => {
  const response = await request(app).get(`/api/marketing-sources/report?businessId=${ownerA.business._id}`);
  expect(response.status).toBe(401);
});

test("administrator selection retains access and refreshed database role is enforced", async () => {
  await User.updateOne({ _id: ownerB.business.owner }, { $set: { role: "admin" } });
  try {
    const response = await get(ownerB, `/api/marketing-sources/report?businessId=${ownerA.business._id}`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body.data)).toContain(String(sourceA._id));
  } finally {
    await User.updateOne({ _id: ownerB.business.owner }, { $set: { role: "owner" } });
  }
  const denied = await get(ownerB, `/api/marketing-sources/report?businessId=${ownerA.business._id}`);
  expect(denied.status).toBe(404);
});
