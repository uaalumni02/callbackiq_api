import request from "supertest";

import app from "../../src/app.js";
import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const minimalSignup = {
  email: "trial-owner@callbackiq.com",
  password: "LongFixturePassword123",
  businessName: "Atlanta Trial Plumbing",
  termsAccepted: true,
  privacyAccepted: true,
};

describe("Trial onboarding registration", () => {
  test("creates an account from the minimal trial signup payload without consuming the trial", async () => {
    const res = await request(app).post("/api/auth/register").send(minimalSignup);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.email).toBe(minimalSignup.email);
    expect(res.body.data.user.userName).toMatch(/^cbq[a-f0-9]{20}$/);
    expect(res.body.data.user.businessPhone).toBe("");
    expect(res.body.data.user.businessType).toBe("other");
    expect(res.body.data.business.forwardingPhone).toBe("");
    expect(res.body.data.business.businessType).toBe("other");
    expect(res.body.data.subscription.status).toBe("none");
    expect(res.body.data.trialGranted).toBe(false);
    expect(res.body.data.trialEligible).toBe(true);

    const subscription = await Subscription.findOne({
      business: res.body.data.business._id,
    });
    expect(subscription.trialUsedAt).toBeFalsy();
    expect(subscription.trialCount).toBe(0);
  });

  test("moves forwarding phone and business type into setup and keeps the owner compatibility fields synchronized", async () => {
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send(minimalSignup);

    expect(registerRes.status).toBe(201);

    const token = registerRes.body.data.token;
    const updateRes = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessType: "plumbing",
        forwardingPhone: "4045551234",
        timezone: "America/New_York",
        smsTemplate:
          "Hi, this is {{businessName}}. Sorry we missed your call. What plumbing service do you need help with today?",
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.businessType).toBe("plumbing");
    expect(updateRes.body.data.forwardingPhone).toBe("+14045551234");
    expect(updateRes.body.data.setupProgress.forwardingPhoneConfigured).toBe(true);

    const owner = await User.findOne({ email: minimalSignup.email });
    expect(owner.businessType).toBe("plumbing");
    expect(owner.businessPhone).toBe("+14045551234");

    const business = await Business.findOne({ owner: owner._id });
    expect(business.forwardingPhone).toBe("+14045551234");
  });
  test("reports a forwarding-phone conflict for a new business name without changing the account", async () => {
    const first = await request(app).post("/api/auth/register").send(minimalSignup);
    expect(first.status).toBe(201);

    const secondPayload = {
      ...minimalSignup,
      email: "second-trial-owner@callbackiq.com",
      businessName: "Second Trial HVAC",
    };
    const second = await request(app).post("/api/auth/register").send(secondPayload);
    expect(second.status).toBe(201);

    const firstUpdate = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${first.body.data.token}`)
      .send({ forwardingPhone: "4045551234" });
    expect(firstUpdate.status).toBe(200);

    const duplicateUpdate = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${second.body.data.token}`)
      .send({
        businessName: "Previously Unused Setup Name",
        forwardingPhone: "(404) 555-1234",
      });

    expect(duplicateUpdate.status).toBe(409);
    expect(duplicateUpdate.body).toMatchObject({
      success: false,
      code: "FORWARDING_PHONE_IN_USE",
      field: "forwardingPhone",
    });
    expect(duplicateUpdate.body.message).toContain("forwarding number");
    expect(duplicateUpdate.body).not.toHaveProperty("business");
    expect(duplicateUpdate.body).not.toHaveProperty("owner");
    const unchangedBusiness = await Business.findById(second.body.data.business._id);
    expect(unchangedBusiness.businessName).toBe(secondPayload.businessName);
    expect(unchangedBusiness.forwardingPhone).toBe("");
    const unchangedOwner = await User.findById(second.body.data.user._id);
    expect(unchangedOwner.businessName).toBe(secondPayload.businessName);
    expect(unchangedOwner.businessPhone).toBe("");

    const retryOwnPhone = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${first.body.data.token}`)
      .send({ businessName: "Updated First Business", forwardingPhone: "(404) 555-1234" });
    expect(retryOwnPhone.status).toBe(200);
    expect(retryOwnPhone.body.data.businessName).toBe("Updated First Business");

    const uniquePhone = await request(app)
      .patch("/api/businesses/mine")
      .set("Authorization", `Bearer ${second.body.data.token}`)
      .send({ businessName: "Previously Unused Setup Name", forwardingPhone: "4045555678" });
    expect(uniquePhone.status).toBe(200);
    expect(uniquePhone.body.data.businessName).toBe("Previously Unused Setup Name");
    expect(uniquePhone.body.data.forwardingPhone).toBe("+14045555678");
  });

  test("format-only saves retain verification and a different phone clears it", async () => {
    const signup = await request(app).post("/api/auth/register").send(minimalSignup);
    expect(signup.status).toBe(201);
    const { token, business } = signup.body.data;
    const verifiedAt = new Date("2026-11-01T12:00:00Z");
    await Business.updateOne({ _id: business._id }, { $set: {
      forwardingPhone: "+14045551234", forwardingPhoneVerifiedValue: "+14045551234", forwardingPhoneVerifiedAt: verifiedAt,
    } });
    const patch = body => request(app).patch("/api/businesses/mine").set("Authorization", `Bearer ${token}`).send(body);
    expect((await patch({ forwardingPhone: "(404) 555-1234" })).status).toBe(200);
    expect(await Business.findById(business._id)).toMatchObject({ forwardingPhoneVerifiedAt: verifiedAt, forwardingPhoneVerifiedValue: "+14045551234" });
    expect((await patch({ forwardingPhone: "4045555678" })).status).toBe(200);
    expect(await Business.findById(business._id)).toMatchObject({ forwardingPhoneVerifiedAt: null, forwardingPhoneVerifiedValue: "" });
  });

  test("allows pre-trial messaging setup while blocking product changes, missing subscriptions and suspension", async () => {
    const signup = await request(app).post("/api/auth/register").send(minimalSignup);
    expect(signup.status).toBe(201);
    const { token, business } = signup.body.data;
    const headers = { Authorization: `Bearer ${token}` };
    const path = "/api/businesses/mine/a2p-registration";
    const registration = await request(app).get(path).set(headers);
    expect(registration.status).toBe(200);
    expect(registration.body.data.canActivateTrial).toBe(false);
    // The empty submission exercises the actual route and fails validation before provider I/O.
    expect((await request(app).post(path).set(headers).send({})).status).toBe(400);
    expect((await request(app).get("/api/leads").set(headers)).status).toBe(403);
    const patch = (data) => request(app).patch("/api/businesses/mine").set(headers).send(data);
    expect((await patch({ businessType: "plumbing", features: { aiQualificationEnabled: false } })).status).toBe(403);
    await Subscription.updateOne({ business: business._id }, { $set: { trialUsedAt: new Date(), trialCount: 1 } });
    expect((await patch({ businessType: "plumbing" })).status).toBe(403);
    await Subscription.updateOne({ business: business._id }, { $set: { trialUsedAt: null, trialCount: 0 } });
    await Business.updateOne({ _id: business._id }, { $set: { isActive: false } });
    expect((await patch({ businessType: "plumbing" })).status).toBe(403);
    expect((await request(app).get(path).set(headers)).status).toBe(403);
    await Business.updateOne({ _id: business._id }, { $set: { isActive: true } });
    await Subscription.deleteOne({ business: business._id });
    expect((await patch({ businessType: "plumbing" })).status).toBe(403);
  });
});
