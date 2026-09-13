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
  password: "Password123",
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
  test("rejects reusing another account's forwarding phone during setup", async () => {
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
      .send({ forwardingPhone: "(404) 555-1234" });

    expect(duplicateUpdate.status).toBe(409);
    expect(duplicateUpdate.body.success).toBe(false);
  });

});
