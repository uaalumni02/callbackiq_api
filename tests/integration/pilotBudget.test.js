import request from "supertest";
import app from "../../src/app.js";
import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import { normalizeVoiceSettings } from "../../src/voice/voiceRouting.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
test("B03 owner cannot raise or disable plan-owned caps", async () => {
  const { token } = await stabilizationFixture();
  const r = await request(app)
    .put("/api/voice-settings")
    .set("Authorization", "Bearer " + token)
    .send({
      monthlyVoiceMinutes: 1000000,
      dailyVoiceMinutes: 100000,
      voiceHardCapEnabled: false,
      voiceOverageEnabled: true,
    });
  expect(r.status).toBe(403);
});
test("B03 normalization cannot resurrect unsafe legacy owner budgets", () => {
  const value = normalizeVoiceSettings({
    voiceSettings: {
      dailyVoiceMinutes: 100000,
      monthlyVoiceMinutes: 1000000,
      voiceHardCapEnabled: false,
      voiceOverageEnabled: true,
    },
  });
  expect(value).toMatchObject({
    dailyVoiceMinutes: 30,
    monthlyVoiceMinutes: 300,
    voiceHardCapEnabled: true,
    voiceOverageEnabled: false,
  });
});
test("B03 reservations enforce the daily plan atomically and cannot be duplicated", async () => {
  const { business } = await stabilizationFixture();
  const { reserveProviderBudget } =
    await import("../../src/services/budgets/providerBudget.service.js");
  const requests = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      reserveProviderBudget({
        businessId: business._id,
        metric: "voice",
        amount: 600,
        key: `atomic-${i}`,
      }),
    ),
  );
  expect(requests.filter((x) => x.status === "fulfilled")).toHaveLength(3);
  expect(
    requests.filter((x) => x.status === "rejected")[0].reason,
  ).toMatchObject({ code: "PROVIDER_BUDGET_EXHAUSTED" });
  const repeated = await reserveProviderBudget({
    businessId: business._id,
    metric: "voice",
    amount: 600,
    key: `atomic-${requests.findIndex((result) => result.status === "fulfilled")}`,
  });
  expect(repeated.replayed).toBe(true);
});
test("B03 circuit breaker and admin-only downward overrides fail closed", async () => {
  const { business, user } = await stabilizationFixture();
  const { reserveProviderBudget } =
    await import("../../src/services/budgets/providerBudget.service.js");
  const { restrictProviderBudget } =
    await import("../../src/services/budgets/budgetOverride.service.js");
  await expect(
    restrictProviderBudget({
      admin: { role: "owner" },
      businessId: business._id,
      limits: { voice: { daily: 0 } },
      reason: "abuse",
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    restrictProviderBudget({
      admin: { role: "admin", userId: user._id },
      businessId: business._id,
      limits: { voice: { daily: 100000 } },
      reason: "unsafe",
    }),
  ).rejects.toMatchObject({ code: "INVALID_BUDGET_OVERRIDE" });
  await restrictProviderBudget({
    admin: { role: "admin", userId: user._id },
    businessId: business._id,
    limits: { voice: { daily: 0 } },
    reason: "supervised pause",
  });
  await expect(
    reserveProviderBudget({
      businessId: business._id,
      metric: "voice",
      amount: 1,
      key: "override",
    }),
  ).rejects.toMatchObject({ code: "PROVIDER_BUDGET_EXHAUSTED" });
  process.env.PILOT_PROVIDER_DISPATCH_PAUSED = "true";
  try {
    await expect(
      reserveProviderBudget({
        businessId: business._id,
        metric: "sms",
        amount: 1,
        key: "paused",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CIRCUIT_OPEN" });
  } finally {
    delete process.env.PILOT_PROVIDER_DISPATCH_PAUSED;
  }
});
test("B03 verified voice settlement refunds unused reserved time once", async () => {
  const { business } = await stabilizationFixture();
  const { reserveProviderBudget, settleProviderBudget } =
    await import("../../src/services/budgets/providerBudget.service.js");
  const mongoose = (await import("mongoose")).default;
  await reserveProviderBudget({
    businessId: business._id,
    metric: "voice",
    amount: 1800,
    key: "settle",
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() =>
      settleProviderBudget({
        businessId: business._id,
        metric: "voice",
        key: "settle",
        actualAmount: 60,
        mongoSession: session,
      }),
    );
  } finally {
    await session.endSession();
  }
  await expect(
    reserveProviderBudget({
      businessId: business._id,
      metric: "voice",
      amount: 1740,
      key: "after-settle",
    }),
  ).resolves.toMatchObject({ allowed: true });
  await expect(
    reserveProviderBudget({
      businessId: business._id,
      metric: "voice",
      amount: 1,
      key: "above-settled-cap",
    }),
  ).rejects.toMatchObject({ code: "PROVIDER_BUDGET_EXHAUSTED" });
});

test("B04 a state change after reservation prevents SDK dispatch and is known to precede the provider", async () => {
  const { business } = await stabilizationFixture();
  const { createSmsProviderDispatcher } =
    await import("../../src/services/messaging/smsProviderDispatch.js");
  const { dispatchEntitledProvider } =
    await import("../../src/services/providerEntitlement.service.js");
  const { reserveProviderBudget } =
    await import("../../src/services/budgets/providerBudget.service.js");
  const Subscription = (await import("../../src/models/subscription.js"))
    .default;
  const client = { messages: { create: jest.fn() } };
  const dispatch = createSmsProviderDispatcher(async () => ({
    dispatchEntitledProvider,
    reserveProviderBudget: async (options) => {
      await reserveProviderBudget(options);
      await Subscription.updateOne(
        { business: business._id },
        { $set: { status: "past_due", isActive: false } },
      );
    },
  }));
  await expect(
    dispatch({
      client,
      businessId: business._id,
      segmentCount: 1,
      operationKey: "queued-state-change",
      params: { to: "+15555550123", body: "Synthetic" },
    }),
  ).rejects.toMatchObject({
    code: "PROVIDER_ENTITLEMENT_REQUIRED",
    providerDispatchNotStarted: true,
  });
  expect(client.messages.create).not.toHaveBeenCalled();
});
test('B03 a replay cannot change its reserved amount and leave a second debit',async()=>{
 const {business}=await stabilizationFixture();const {reserveProviderBudget}=await import('../../src/services/budgets/providerBudget.service.js');
 await reserveProviderBudget({businessId:business._id,metric:'sms',key:'synthetic-immutable',amount:1});
 await expect(reserveProviderBudget({businessId:business._id,metric:'sms',key:'synthetic-immutable',amount:2})).rejects.toMatchObject({code:'PROVIDER_BUDGET_KEY_CONFLICT'});
 const {default:Counter}=await import('../../src/models/providerBudgetCounter.js');expect((await Counter.find().lean()).map(row=>row.used)).toEqual([1,1,1,1]);
});
test.each([{businessId:null,key:'synthetic',amount:1},{businessId:'tenant',key:'',amount:1},{businessId:'tenant',key:'synthetic',amount:0},{businessId:'tenant',key:'synthetic',amount:1.5}])('B03 malformed budget identity cannot authorize any provider charge: %p',async input=>{
 const {reserveProviderBudget}=await import('../../src/services/budgets/providerBudget.service.js');
 await expect(reserveProviderBudget({...input,metric:'sms'})).rejects.toMatchObject({code:'PROVIDER_BUDGET_CONTEXT_REQUIRED'});
 const {default:Counter}=await import('../../src/models/providerBudgetCounter.js');expect(await Counter.countDocuments()).toBe(0);
});
