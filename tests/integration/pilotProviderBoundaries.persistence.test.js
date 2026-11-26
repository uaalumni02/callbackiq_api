import request from "supertest";
import mongoose from "mongoose";
import OpenAI from "openai";
import app from "../../src/app.js";
import { stabilizationFixture } from "../setup/stabilizationFixture.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testReplicaDb.js";
import Operations from "../../src/models/businessOperationsSettings.js";
import Business from "../../src/models/business.js";
import User from "../../src/models/user.js";
import Subscription from "../../src/models/subscription.js";
import AdminLog from "../../src/models/adminActionLog.js";
import Delivery from "../../src/models/staffNotificationDelivery.js";
import Counter from "../../src/models/providerBudgetCounter.js";
import Reservation from "../../src/models/providerBudgetReservation.js";
import Heartbeat from "../../src/models/maintenanceTaskHeartbeat.js";
import Token from "../../src/helpers/jwt/token.js";
import * as notifications from "../../src/services/notifications/testStaffNotifications.service.js";
import * as budgets from "../../src/services/budgets/providerBudget.service.js";
import { settleVoiceBudgetReservations } from "../../src/services/budgets/voiceBudgetSettlement.js";
import { createOpenAIClient } from "../../src/integrations/providerClients.js";
import { withProviderBusiness } from "../../src/services/providerEntitlement.service.js";
import { runPilotMaintenanceOnce } from "../../src/services/privacy/pilotMaintenance.service.js";
import { runStaffSms } from "../../src/services/staffSms.service.js";
import { runApprovalSms } from "../../src/services/scheduling/approvalSms.service.js";
const mockAiCall = jest.fn();
jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    responses: { create: (...args) => mockAiCall(...args) },
  })),
}));
const originalTest = notifications.testSavedStaffNotifications;
const originalFlags = {
  email: process.env.STAFF_NOTIFICATION_EMAIL_ENABLED,
  sms: process.env.STAFF_NOTIFICATION_SMS_ENABLED,
};
beforeAll(connectTestDB, 60000);
beforeEach(() => {
  jest.clearAllMocks();
  mockAiCall.mockResolvedValue({ id: "response-synthetic" });
  process.env.STAFF_NOTIFICATION_EMAIL_ENABLED = "true";
  process.env.STAFF_NOTIFICATION_SMS_ENABLED = "true";
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDB();
});
afterAll(async () => {
  for (const [key, value] of [
    ["STAFF_NOTIFICATION_EMAIL_ENABLED", originalFlags.email],
    ["STAFF_NOTIFICATION_SMS_ENABLED", originalFlags.sms],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeTestDB();
});
async function team() {
  const f = await stabilizationFixture();
  await Operations.create({
    business: f.business._id,
    humanHandoffContacts: [
      {
        name: "Saved dispatcher",
        active: true,
        email: "saved@example.com",
        phone: "+15555550121",
      },
    ],
    emergencyPolicy: {
      emergencyContactEmail: "urgent@example.com",
      emergencyContactPhone: "+15555550122",
    },
  });
  return f;
}
function injectedTest() {
  const emailSend = jest.fn(async () => ({
      accepted: ["synthetic"],
      messageId: "email-synthetic",
    })),
    smsSend = jest.fn(async () => ({ sid: "SM_SYNTHETIC" }));
  jest
    .spyOn(notifications, "testSavedStaffNotifications")
    .mockImplementation((options) =>
      originalTest({ ...options, emailSend, smsSend }),
    );
  return { emailSend, smsSend };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
test("H02 the saved notification action uses only current tenant contacts, receipts and cooldown", async () => {
  const f = await team(),
    other = await stabilizationFixture(),
    send = injectedTest();
  const result = await request(app)
    .post("/api/business-configuration/owner-settings/test-notifications")
    .set(auth(f.token))
    .send({ businessId: other.business._id, email: "attacker@example.test" });
  expect(result.status).toBe(200);
  expect(result.body.data.results.email.state).toBe("accepted");
  expect(result.body.data.results.sms.state).toBe("accepted");
  expect(send.emailSend.mock.calls.map(([x]) => x.email).sort()).toEqual([
    "saved@example.com",
    "urgent@example.com",
  ]);
  expect(send.smsSend).toHaveBeenCalledTimes(2);
  expect(await Delivery.countDocuments({ business: other.business._id })).toBe(
    0,
  );
  expect(result.body.data.deliveries).toHaveLength(4);
  expect(
    (
      await request(app)
        .post("/api/business-configuration/owner-settings/test-notifications")
        .set(auth(f.token))
        .send({})
    ).status,
  ).toBe(429);
  expect(send.smsSend).toHaveBeenCalledTimes(2);
});
test("H02 a notification test does not make a saved settings draft stale", async () => {
  const f = await team();
  injectedTest();
  const before = await request(app)
    .get("/api/business-configuration/owner-settings")
    .set(auth(f.token));
  expect(before.status).toBe(200);
  expect(
    (
      await request(app)
        .post("/api/business-configuration/owner-settings/test-notifications")
        .set(auth(f.token))
        .send({})
    ).status,
  ).toBe(200);
  const save = await request(app)
    .put("/api/business-configuration/owner-settings/team")
    .set(auth(f.token))
    .send({
      revision: before.body.data.revision,
      values: before.body.data.sections.team,
    });
  expect([save.status, save.body]).toEqual([
    200,
    expect.objectContaining({ success: true }),
  ]);
});
test("H02 missing saved contacts and disabled channels report blocked rather than delivered", async () => {
  const f = await stabilizationFixture();
  await expect(
    originalTest({ businessId: f.business._id }),
  ).rejects.toMatchObject({ statusCode: 429 });
  await Operations.create({ business: f.business._id });
  process.env.STAFF_NOTIFICATION_EMAIL_ENABLED = "false";
  process.env.STAFF_NOTIFICATION_SMS_ENABLED = "false";
  const value = await originalTest({ businessId: f.business._id });
  expect(value.results.email).toMatchObject({
    state: "blocked",
    reason: "EMAIL_DISABLED",
  });
  expect(value.results.sms).toMatchObject({
    state: "blocked",
    reason: "SMS_DISABLED",
  });
  expect(value.deliveries).toEqual([]);
  await Business.updateOne(
    { _id: f.business._id },
    { $set: { isActive: false } },
  );
  await expect(
    originalTest({ businessId: f.business._id }),
  ).rejects.toMatchObject({ statusCode: 404 });
});
test("B03 actual admin route enforces a lower cap and records an audit trail; invalid increases fail", async () => {
  const f = await stabilizationFixture();
  await User.updateOne({ _id: f.user._id }, { $set: { role: "admin" } });
  const token = Token.sign({
    userId: String(f.user._id),
    role: "admin",
    sessionVersion: 0,
    mfaVerified: true,
    authTime: Math.floor(Date.now() / 1000),
  });
  const path = `/api/admin/businesses/${f.business._id}/provider-budget`;
  const result = await request(app)
    .patch(path)
    .set(auth(token))
    .send({
      limits: { voice: { daily: 60 } },
      reason: "Supervised pilot restriction",
    });
  expect(result.status).toBe(200);
  expect(result.body.data.limits.voice.daily).toBe(60);
  expect(
    await AdminLog.findOne({
      targetBusiness: f.business._id,
      action: "update_provider_budget",
    }),
  ).not.toBeNull();
  expect(
    (
      await request(app)
        .patch(path)
        .set(auth(token))
        .send({
          limits: { voice: { daily: 999999 } },
          reason: "Invalid increase",
        })
    ).status,
  ).toBe(400);
});
test("B03 verified multi-reservation settlement refunds only unused seconds and never repeats a refund", async () => {
  const { business } = await stabilizationFixture();
  const session = await mongoose.startSession();
  for (const [key, amount] of [
    ["first", 100],
    ["second", 200],
  ])
    await budgets.reserveProviderBudget({
      businessId: business._id,
      metric: "voice",
      key,
      amount,
    });
  const reservations = [
    { reservationKey: "first", requestedSeconds: 100 },
    { reservationKey: "second", requestedSeconds: 200 },
  ];
  try {
    await session.withTransaction(() =>
      settleVoiceBudgetReservations({
        businessId: business._id,
        reservations,
        actualSeconds: 150,
        mongoSession: session,
      }),
    );
    await session.withTransaction(() =>
      settleVoiceBudgetReservations({
        businessId: business._id,
        reservations,
        actualSeconds: 150,
        mongoSession: session,
      }),
    );
  } finally {
    await session.endSession();
  }
  const fleet = await Counter.find({ _id: { $regex: "^fleet:voice:" } }).lean();
  expect(fleet).toHaveLength(2);
  expect(fleet.map((x) => x.used)).toEqual([150, 150]);
  expect(await Reservation.countDocuments({ state: "settled" })).toBe(2);
});
test.each([undefined, 100, 900])(
  "B03 OpenAI SDK boundary reserves current entitlement and clamps output: %p",
  async (max_output_tokens) => {
    const { business } = await stabilizationFixture();
    const client = createOpenAIClient("pilot-recovery", {
      apiKey: "inert-offline-key",
      maxRetries: 4,
    });
    await withProviderBusiness(business._id, () =>
      client.responses.create({
        model: "synthetic-model",
        input: "Synthetic request",
        max_output_tokens,
      }),
    );
    expect(OpenAI).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
    );
    expect(mockAiCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        max_output_tokens: max_output_tokens === 100 ? 100 : 700,
      }),
    );
    expect(await Reservation.countDocuments({ metric: "ai" })).toBe(1);
  },
);
test("B04 an entitlement change after AI reservation prevents SDK dispatch", async () => {
  const { business } = await stabilizationFixture(),
    reserve = budgets.reserveProviderBudget;
  jest
    .spyOn(budgets, "reserveProviderBudget")
    .mockImplementation(async (input) => {
      const value = await reserve(input);
      await Subscription.updateOne(
        { business: business._id },
        { $set: { status: "past_due", isActive: false } },
      );
      return value;
    });
  const client = createOpenAIClient("pilot-recovery", {
    apiKey: "inert-offline-key",
  });
  await expect(
    withProviderBusiness(business._id, () =>
      client.responses.create({ model: "synthetic" }),
    ),
  ).rejects.toMatchObject({ code: "PROVIDER_ENTITLEMENT_REQUIRED" });
  expect(mockAiCall).not.toHaveBeenCalled();
});
test("B03 AI provider errors are attempted once and the unknown request is not refunded", async () => {
  const { business } = await stabilizationFixture();
  mockAiCall.mockRejectedValue(
    Object.assign(new Error("synthetic unavailable"), { status: 429 }),
  );
  const client = createOpenAIClient("pilot-recovery", {
    apiKey: "inert-offline-key",
  });
  await expect(
    withProviderBusiness(business._id, () =>
      client.responses.create({ model: "synthetic" }),
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(mockAiCall).toHaveBeenCalledTimes(1);
  expect(await Reservation.countDocuments({ metric: "ai" })).toBe(1);
});
test("M06 a failed stale-session sweep records failure and cannot masquerade as a success heartbeat", async () => {
  await expect(
    runPilotMaintenanceOnce({
      operations: {
        redact: async () => ({ modified: 0 }),
        reap: async () => ({ errors: 1 }),
        deletions: async () => ({ completed: 0 }),
      },
    }),
  ).rejects.toMatchObject({ code: "PRIVACY_SWEEP_PARTIAL" });
  const row = await Heartbeat.findById("pilot-privacy").lean();
  expect(row.lastFailedAt).toBeInstanceOf(Date);
  expect(row.lastErrorCode).toBe("PRIVACY_SWEEP_PARTIAL");
  expect(row.lastSucceededAt).toBeFalsy();
});
test("M05 default worker entrypoints safely process an empty tenant queue", async () => {
  await expect(runStaffSms()).resolves.toBeDefined();
  await expect(runApprovalSms()).resolves.toBeDefined();
});
