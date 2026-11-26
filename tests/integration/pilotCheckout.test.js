import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import { createSubscriptionCheckout } from "../../src/services/trialLifecycle.service.js";
import { getStripeClient } from "../../src/helpers/stripe/stripeClient.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
jest.mock("../../src/helpers/stripe/stripeClient.js", () => ({
  getStripeClient: jest.fn(),
  getPriceIdByPlan: (plan) =>
    ["pro", "starter"].includes(plan) ? "price_" + plan : null,
}));
let stripe, sessions, keys;
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
beforeEach(() => {
  sessions = new Map();
  keys = new Map();
  stripe = {
    customers: {
      search: jest.fn(async () => ({ data: [] })),
      create: jest.fn(async () => ({ id: "cus_pilot" })),
    },
    subscriptions: {
      list: jest.fn(async () => ({ data: [] })),
      retrieve: jest.fn(async () => ({ id: "sub_old", status: "canceled" })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async (params, options) => {
          if (keys.has(options.idempotencyKey))
            return sessions.get(keys.get(options.idempotencyKey));
          const id = "cs_" + (sessions.size + 1),
            session = {
              id,
              url: "https://checkout.example.test/" + id,
              status: "open",
              metadata: params.metadata,
            };
          sessions.set(id, session);
          keys.set(options.idempotencyKey, id);
          return session;
        }),
        retrieve: jest.fn(async (id) => sessions.get(id)),
        expire: jest.fn(async (id) => {
          sessions.get(id).status = "expired";
          return sessions.get(id);
        }),
      },
    },
  };
  getStripeClient.mockReturnValue(stripe);
});
async function fixture(changes = {}) {
  const owner = await User.create({
    userName: "pilot-checkout",
    email: "checkout@example.test",
    password: "inert-hash",
    role: "owner",
    businessName: "Pilot checkout",
    emailVerifiedAt: new Date(),
  });
  const business = await Business.create({
    owner: owner._id,
    businessName: "Pilot checkout",
    email: owner.email,
    forwardingPhone: "+14045550101",
    forwardingPhoneVerifiedValue: "+14045550101",
    forwardingPhoneVerifiedAt: new Date(),
    phone: "+14045550102",
    trackingNumber: { status: "active", providerSid: "PN_PILOT" },
    messagingCompliance: { smsReady: false, a2pStatus: "pending" },
    ...changes,
  });
  await Subscription.create({
    business: business._id,
    status: "none",
    isActive: false,
    lastPaymentStatus: "trial_not_activated",
  });
  return { business, ownerId: owner._id, plan: "pro" };
}
test("B06 paid checkout rejects an unprovisioned business without provider charge", async () => {
  const input = await fixture({
    phone: "",
    trackingNumber: { status: "unassigned" },
  });
  await expect(createSubscriptionCheckout(input)).rejects.toMatchObject({
    code: "PAID_SERVICE_NOT_READY",
  });
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("B06 A2P pending is explicit and verified service-ready owners can pay", async () => {
  const input = await fixture();
  const result = await createSubscriptionCheckout(input);
  expect(result.checkoutUrl).toBeTruthy();
  expect(result.smsPending).toBe(true);
  expect(
    stripe.checkout.sessions.create.mock.calls[0][0].custom_text.submit.message,
  ).toMatch(/carrier approval/i);
});
test("B07 only PRO is accepted even when another price is configured", async () => {
  const input = await fixture();
  await expect(
    createSubscriptionCheckout({ ...input, plan: "starter" }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_PILOT_PLAN" });
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("B07 concurrent creation and retries keep one open remote attempt", async () => {
  const input = await fixture();
  const results = await Promise.allSettled([
    createSubscriptionCheckout(input),
    createSubscriptionCheckout(input),
  ]);
  expect(results.some((x) => x.status === "fulfilled")).toBe(true);
  const retry = await createSubscriptionCheckout(input);
  expect(sessions.size).toBe(1);
  expect(retry.checkoutSessionId).toBe([...sessions.keys()][0]);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test("H01 terminal completion or expiry creates a fresh attempt key", async () => {
  const input = await fixture();
  const first = await createSubscriptionCheckout(input);
  sessions.get(first.checkoutSessionId).status = "complete";
  await Subscription.updateOne(
    { business: input.business._id },
    { $set: { status: "canceled", isActive: false } },
  );
  const second = await createSubscriptionCheckout(input);
  expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
  sessions.get(second.checkoutSessionId).status = "expired";
  const third = await createSubscriptionCheckout(input);
  expect(third.checkoutSessionId).not.toBe(second.checkoutSessionId);
  expect(new Set(keys.keys()).size).toBe(3);
});
test("B07 an interrupted create retries the durable original intent without another remote session", async () => {
  const input = await fixture();
  const create = stripe.checkout.sessions.create.getMockImplementation();
  let first = true;
  stripe.checkout.sessions.create.mockImplementation(async (...args) => {
    const session = await create(...args);
    if (first) {
      first = false;
      throw Object.assign(new Error("mock timeout"), { code: "ETIMEDOUT" });
    }
    return session;
  });
  await expect(createSubscriptionCheckout(input)).rejects.toMatchObject({
    code: "ETIMEDOUT",
  });
  const retry = await createSubscriptionCheckout({
    ...input,
    returnToSetup: true,
  });
  expect(retry.checkoutSessionId).toBe("cs_1");
  expect(sessions.size).toBe(1);
  expect(
    new Set(
      stripe.checkout.sessions.create.mock.calls.map(
        ([, options]) => options.idempotencyKey,
      ),
    ).size,
  ).toBe(1);
});
test("B07 superseded open activation links are verified expired before replacement", async () => {
  const input = await fixture();
  const first = await createSubscriptionCheckout(input);
  const { default: Attempt } =
    await import("../../src/models/checkoutAttempt.js");
  await Attempt.updateOne(
    { business: input.business._id },
    { $set: { purpose: "trial" } },
  );
  const second = await createSubscriptionCheckout(input);
  expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
  expect(sessions.get(first.checkoutSessionId).status).toBe("expired");
  expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
});
test("H01 uncertain attempts past the safe idempotency window cannot create another session", async () => {
  const input = await fixture();
  stripe.checkout.sessions.create.mockRejectedValue(new Error("mock timeout"));
  await expect(createSubscriptionCheckout(input)).rejects.toThrow(
    "mock timeout",
  );
  const { default: Attempt } =
    await import("../../src/models/checkoutAttempt.js");
  await Attempt.updateOne(
    { business: input.business._id },
    { $set: { attemptStartedAt: new Date(Date.now() - 86400000) } },
  );
  await expect(createSubscriptionCheckout(input)).rejects.toMatchObject({
    code: "CHECKOUT_RECONCILIATION_REQUIRED",
  });
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test("H01 old terminal document timestamps do not prevent a fresh generation", async () => {
  const input = await fixture();
  const first = await createSubscriptionCheckout(input);
  sessions.get(first.checkoutSessionId).status = "expired";
  const { default: Attempt } =
    await import("../../src/models/checkoutAttempt.js");
  await Attempt.collection.updateOne(
    { business: input.business._id },
    { $set: { createdAt: new Date(0), attemptStartedAt: new Date(0) } },
  );
  const second = await createSubscriptionCheckout(input);
  expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
});
test("B07 stale local billing cannot open another checkout while Stripe has an active subscription", async () => {
  const input = await fixture();
  await createSubscriptionCheckout(input);
  stripe.subscriptions.list.mockResolvedValue({
    data: [{ id: "sub_already_paid", status: "active" }],
  });
  await expect(createSubscriptionCheckout(input)).rejects.toMatchObject({
    code: "STRIPE_SUBSCRIPTION_ALREADY_EXISTS",
  });
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test("B07 pre-migration open links must be expired before new session creation", async () => {
  const input = await fixture();
  sessions.set("cs_legacy", {
    id: "cs_legacy",
    status: "open",
    url: "https://checkout.example.test/legacy",
  });
  await Subscription.updateOne(
    { business: input.business._id },
    { $set: { checkoutSessionId: "cs_legacy" } },
  );
  const current = await createSubscriptionCheckout(input);
  expect(current.checkoutSessionId).not.toBe("cs_legacy");
  expect(sessions.get("cs_legacy").status).toBe("expired");
});
test("H01 missing uncertain-attempt timestamps never manufacture a fresh retry window", async () => {
  const input = await fixture();
  stripe.checkout.sessions.create.mockRejectedValue(new Error("mock timeout"));
  await expect(createSubscriptionCheckout(input)).rejects.toThrow(
    "mock timeout",
  );
  const { default: Attempt } =
    await import("../../src/models/checkoutAttempt.js");
  await Attempt.collection.updateOne(
    { business: input.business._id },
    { $unset: { attemptStartedAt: "" } },
  );
  await expect(createSubscriptionCheckout(input)).rejects.toMatchObject({
    code: "CHECKOUT_RECONCILIATION_REQUIRED",
  });
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});

test.each(['expired','complete','unknown','mismatched','expiry_unverified'])('B07 legacy %s checkout receipts cannot create a duplicate charge',async state=>{
 const input=await fixture();const id='cs_legacy';sessions.set(id,{id:state==='mismatched'?'cs_other':id,status:state==='expiry_unverified'?'open':state,url:'https://checkout.example.test/legacy'});
 await Subscription.updateOne({business:input.business._id},{$set:{checkoutSessionId:id}});
 if(state==='expiry_unverified')stripe.checkout.sessions.expire.mockResolvedValue({id,status:'open'});
 if(state==='expired'){await expect(createSubscriptionCheckout(input)).resolves.toBeDefined();expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);}
 else {await expect(createSubscriptionCheckout(input)).rejects.toMatchObject({code:state==='expiry_unverified'?'CHECKOUT_EXPIRATION_UNVERIFIED':'CHECKOUT_RECONCILIATION_REQUIRED'});expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();}
});
