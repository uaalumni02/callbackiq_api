import mongoose from "mongoose";
import express from "express";
import request from "supertest";
import adminRoutes from "../../src/routes/admin.routes.js";
import Token from "../../src/helpers/jwt/token.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";
import {
  refreshBusinessReport,
  founderOverview,
  listCustomers,
  invoiceTotals,
} from "../../src/services/admin/founderReporting.service.js";
import {
  billingState,
  rate,
  costSummary,
  DAY,
} from "../../src/services/admin/reportingPolicy.js";
import {
  normalizeReportingInvoice,
  normalizedMonthlyCents,
  syncBusinessBillingReport,
} from "../../src/services/admin/billingReporting.service.js";
import {
  AdminBusinessReport,
  AdminBillingFact,
  AdminReportingState,
  AdminCostRecord,
  AdminCompanyExpense,
  AdminExpenseRule,
  AdminReportingProfile,
} from "../../src/models/adminReporting.js";
import Business from "../../src/models/business.js";
import User from "../../src/models/user.js";
import Lead from "../../src/models/lead.js";
import Message from "../../src/models/message.js";
import CallLog from "../../src/models/callLog.js";
import Appointment from "../../src/models/appointment.js";
import Subscription from "../../src/models/subscription.js";
import AdminActionLog from "../../src/models/adminActionLog.js";
const app = express();
app.use(express.json());
app.use("/admin", adminRoutes);
const now = new Date("2026-09-07T20:00:00Z");
const oid = () => new mongoose.Types.ObjectId();
let business, user, token;
beforeAll(async () => {
  process.env.ADMIN_REPORTING_STRIPE_SYNC = "false";
  await connectTestDB();
}, 120000);
afterEach(clearTestDB);
afterAll(closeTestDB);
beforeEach(async () => {
  user = oid();
  business = oid();
  await User.collection.insertOne({
    _id: user,
    userName: "Founder",
    email: "admin@example.com",
    role: "admin",
    password: "never-return-me",
    termsAccepted: true,
    privacyAccepted: true,
    sessionVersion: 0,
  });
  await Business.collection.insertOne({
    _id: business,
    owner: user,
    businessName: "Real Plumbing",
    businessType: "plumbing",
    isActive: true,
    features: { missedCallSmsEnabled: true, voiceAiEnabled: false },
    trackingNumber: { status: "active" },
    messagingCompliance: {
      smsReady: true,
      senderAttached: true,
      a2pStatus: "registered",
    },
    createdAt: new Date(+now - 60 * DAY),
  });
  await Subscription.collection.insertOne({
    business,
    plan: "pro",
    status: "active",
    isActive: true,
    stripeSubscriptionId: "sub_real",
    priceMonthly: 99,
    lastPaymentStatus: "paid",
  });
  token = Token.sign({
    userId: String(user),
    role: "admin",
    sessionVersion: 0,
  });
});
const seedInvoice = async () => {
  await AdminBillingFact.create({
    business,
    invoiceId: "in_real",
    livemode: true,
    currency: "usd",
    status: "paid",
    amountPaidCents: 9900,
    allocatableCents: 9900,
    amountRemainingCents: 0,
    paidAt: new Date("2026-09-01"),
    periodStart: new Date("2026-09-01"),
    periodEnd: new Date("2026-10-01"),
    recurring: true,
  });
  await AdminReportingState.create({
    _id: `billing:${business}`,
    data: { complete: true, syncedAt: now, monthlyCents: 9900, livemode: true },
  });
};
test("billing never treats trials, unbacked active records or test payments as paid customers", () => {
  expect(
    billingState(
      { status: "trialing", stripeSubscriptionId: "sub_1", priceMonthly: 99 },
      [],
      now,
    ).mrrCents,
  ).toBe(0);
  expect(
    billingState(
      {
        status: "active",
        stripeSubscriptionId: "sub_1",
        lastPaymentStatus: "paid",
        priceMonthly: 99,
      },
      [
        {
          livemode: false,
          currency: "usd",
          paidAt: now,
          amountPaidCents: 9900,
        },
      ],
      now,
    ).paid,
  ).toBe(false);
  expect(rate(0, 0).value).toBeNull();
});
test("monthly normalization handles annual quantities and rejects unknown/tiered currencies", () => {
  expect(
    normalizedMonthlyCents({
      items: {
        data: [
          {
            quantity: 2,
            price: {
              unit_amount: 118800,
              currency: "usd",
              recurring: { interval: "year" },
            },
          },
        ],
      },
    }),
  ).toBe(19800);
  expect(
    normalizedMonthlyCents({
      items: {
        data: [
          {
            price: {
              unit_amount: 99,
              currency: "eur",
              recurring: { interval: "month" },
            },
          },
        ],
      },
    }),
  ).toBeNull();
});
test("incomplete cost categories cannot produce a fabricated margin", () => {
  const result = costSummary([], { twilioEstimatedCostCents: 500 }, now, 9900);
  expect(result.knownCostCents).toBe(500);
  expect(result.complete).toBe(false);
  expect(result.marginCents).toBeNull();
});
test("invoice normalization is privacy-safe and recognizes modern subscription parent fields", () => {
  const fact = normalizeReportingInvoice(
    {
      id: "in_1",
      parent: { subscription_details: { subscription: "sub_1" } },
      customer_email: "private@example.com",
      livemode: true,
      currency: "usd",
      amount_paid: 10800,
      total: 10800,
      total_excluding_tax: 10000,
      lines: {
        data: [
          {
            parent: { subscription_item_details: {} },
            period: { start: 100, end: 200 },
          },
        ],
      },
    },
    business,
    now,
  );
  expect(fact.subscriptionId).toBe("sub_1");
  expect(fact.allocatableCents).toBe(10000);
  expect(fact).not.toHaveProperty("customer_email");
});
test("reports exclude direct and linked fixtures, count voicemail, and keep approvals out of confirmed bookings", async () => {
  await seedInvoice();
  const real = oid(),
    fake = oid();
  await Lead.collection.insertMany([
    {
      _id: real,
      business,
      createdAt: new Date(+now - DAY),
      firstRespondedAt: new Date(+now - DAY),
      phone: "+14709052222",
    },
    {
      _id: fake,
      business,
      createdAt: new Date(+now - DAY),
      summary: "[load-2026] synthetic authorized load test lead",
    },
  ]);
  await Message.collection.insertMany([
    {
      business,
      lead: real,
      direction: "outbound",
      status: "delivered",
      createdAt: new Date(+now - DAY),
      body: "private",
      segmentCount: 2,
    },
    {
      business,
      lead: fake,
      direction: "inbound",
      createdAt: new Date(+now - DAY),
      body: "private fake",
    },
  ]);
  await CallLog.collection.insertMany([
    {
      business,
      lead: real,
      status: "voicemail",
      direction: "inbound",
      createdAt: new Date(+now - DAY),
      recovered: true,
    },
    {
      business,
      lead: fake,
      status: "missed",
      direction: "inbound",
      createdAt: new Date(+now - DAY),
    },
    {
      business,
      from: "+14045550123",
      status: "missed",
      direction: "inbound",
      createdAt: new Date(+now - DAY),
    },
  ]);
  await Appointment.collection.insertMany([
    {
      business,
      lead: real,
      idempotencyKey: "held-1",
      status: "held",
      requiresBusinessApproval: true,
      approvalRequestedAt: new Date(+now - DAY),
      createdAt: new Date(+now - DAY),
    },
    {
      business,
      lead: real,
      idempotencyKey: "confirmed-1",
      status: "confirmed",
      confirmedAt: new Date(+now - DAY),
      createdAt: new Date(+now - DAY),
    },
    {
      business,
      lead: real,
      idempotencyKey: "canceled-1",
      status: "canceled",
      confirmedAt: new Date(+now - DAY),
      createdAt: new Date(+now - DAY),
    },
  ]);
  const row = await refreshBusinessReport(business, now);
  expect(row.billing.mrrCents).toBe(9900);
  expect(row.readiness.ready).toBe(true);
  expect(row.windows[30]).toMatchObject({
    calls: 1,
    missedCalls: 1,
    recoveredCalls: 1,
    leads: 1,
    messages: 1,
    repliedLeads: 0,
    bookings: 1,
    smsSegments: 2,
  });
  expect(row.health.pendingApprovals).toBe(1);
  expect(JSON.stringify(row)).not.toContain("private fake");
  expect(JSON.stringify(row)).not.toContain("never-return-me");
  expect(row.windows[30].actualRevenue).toBeNull();
});
test("inbound message evidence counts replies and reporting never writes operational records", async () => {
  const lead = oid();
  await Lead.collection.insertOne({
    _id: lead,
    business,
    createdAt: new Date(+now - DAY),
    phone: "+14709052222",
  });
  await Message.collection.insertOne({
    business,
    lead,
    direction: "inbound",
    createdAt: new Date(+now - DAY),
  });
  const before = await Business.findById(business).lean();
  const row = await refreshBusinessReport(business, now);
  expect(row.windows[30].repliedLeads).toBe(1);
  expect(await Business.findById(business).lean()).toEqual(before);
});
test("auth uses current DB role; retired subscription mutation cannot change or upsert billing", async () => {
  expect((await request(app).get("/admin/dashboard")).status).toBe(401);
  const res = await request(app)
    .patch(`/admin/customers/${business}/subscription-status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "past_due" });
  expect(res.status).toBe(410);
  expect((await Subscription.findOne({ business })).status).toBe("active");
  await User.updateOne({ _id: user }, { $set: { role: "owner" } });
  expect(
    (
      await request(app)
        .get("/admin/dashboard")
        .set("Authorization", `Bearer ${token}`)
    ).status,
  ).toBe(403);
});
test("details contain only required fields and audit sensitive reads, not dashboard refreshes", async () => {
  await refreshBusinessReport(business, now);
  const details = await request(app)
    .get(`/admin/customers/${business}`)
    .set("Authorization", `Bearer ${token}`);
  expect(details.status).toBe(200);
  for (const key of ["messages", "calls", "leads", "conversations"])
    expect(details.body.data).not.toHaveProperty(key);
  expect(await AdminActionLog.countDocuments({ action: "view_customer" })).toBe(
    1,
  );
  const overview = await request(app)
    .get("/admin/dashboard?days=7")
    .set("Authorization", `Bearer ${token}`);
  expect(overview.status).toBe(200);
  expect(
    await AdminActionLog.countDocuments({ action: "view_dashboard" }),
  ).toBe(0);
});
test("cost writes replace totals, validate cutoff and record audit history", async () => {
  const payload = {
    period: "2026-09",
    category: "sms",
    amountCents: 100,
    basis: "estimated",
    throughDate: "2026-09-01",
    reference: "September estimate",
  };
  expect(
    (
      await request(app)
        .put(`/admin/customers/${business}/reporting-cost`)
        .set("Authorization", `Bearer ${token}`)
        .send(payload)
    ).status,
  ).toBe(200);
  expect(
    (
      await request(app)
        .put(`/admin/customers/${business}/reporting-cost`)
        .set("Authorization", `Bearer ${token}`)
        .send({ ...payload, amountCents: 200 })
    ).status,
  ).toBe(200);
  expect(await AdminCostRecord.countDocuments({ business })).toBe(1);
  expect((await AdminCostRecord.findOne({ business })).amountCents).toBe(200);
  expect(
    await AdminActionLog.countDocuments({ action: "update_reporting_cost" }),
  ).toBe(2);
  expect(
    (
      await request(app)
        .put(`/admin/customers/${business}/reporting-cost`)
        .set("Authorization", `Bearer ${token}`)
        .send({ ...payload, amountCents: -1 })
    ).status,
  ).toBe(400);
});
test("pagination is bounded and exclusion changes overview without deleting customers", async () => {
  await refreshBusinessReport(business, now);
  expect((await listCustomers({ page: 1, limit: 1 })).pagination.total).toBe(1);
  expect(
    (
      await request(app)
        .get("/admin/dashboard?limit=1000")
        .set("Authorization", `Bearer ${token}`)
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .patch(`/admin/customers/${business}/reporting-profile`)
        .set("Authorization", `Bearer ${token}`)
        .send({ excluded: true, exclusionReason: "Pilot fixture" })
    ).status,
  ).toBe(200);
  expect((await listCustomers()).customers).toHaveLength(0);
  expect(
    (await listCustomers({ includeExcluded: true })).customers,
  ).toHaveLength(1);
  expect(await Business.countDocuments({})).toBe(1);
});
test("invoice retries upsert by invoice identity; test mode stays outside financial coverage", async () => {
  const stripe = {
    subscriptions: {
      retrieve: jest.fn().mockResolvedValue({
        status: "active",
        livemode: false,
        items: {
          data: [
            {
              price: {
                currency: "usd",
                unit_amount: 9900,
                recurring: { interval: "month" },
              },
            },
          ],
        },
      }),
    },
    invoices: {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: "in_duplicate",
            subscription: "sub_real",
            status: "paid",
            livemode: false,
            currency: "usd",
            amount_paid: 9900,
          },
        ],
        has_more: false,
      }),
    },
  };
  await syncBusinessBillingReport(business, { stripe, force: true, now });
  await syncBusinessBillingReport(business, { stripe, force: true, now });
  expect(await AdminBillingFact.countDocuments({ business })).toBe(1);
  expect(
    (await AdminReportingState.findById(`billing:${business}`)).data.complete,
  ).toBe(false);
});
test("business-status access control remains functional without changing subscription billing", async () => {
  const res = await request(app)
    .patch(`/admin/customers/${business}/business-status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ isActive: false });
  expect(res.status).toBe(200);
  expect((await Business.findById(business)).isActive).toBe(false);
  expect((await Subscription.findOne({ business })).status).toBe("active");
});
test("zero-value completed jobs remain distinguishable from unrecorded positive revenue", async () => {
  const real = oid();
  await Lead.collection.insertOne({
    _id: real,
    business,
    createdAt: new Date(+now - DAY),
  });
  await Appointment.collection.insertMany([
    {
      business,
      lead: real,
      idempotencyKey: "complete-1",
      status: "completed",
      completedAt: new Date(+now - DAY),
      confirmedAt: new Date(+now - 2 * DAY),
      actualRevenue: 150,
    },
    {
      business,
      lead: real,
      idempotencyKey: "complete-2",
      status: "completed",
      completedAt: new Date(+now - DAY),
      confirmedAt: new Date(+now - 2 * DAY),
      actualRevenue: 0,
    },
  ]);
  const row = await refreshBusinessReport(business, now);
  expect(row.windows[30]).toMatchObject({
    bookings: 2,
    completedJobs: 2,
    recordedRevenueJobs: 1,
    actualRevenue: 150,
  });
});
test("seven-day activity excludes older events and compares with the preceding seven days", async () => {
  await CallLog.collection.insertMany([
    {
      business,
      createdAt: new Date(+now - 2 * DAY),
      status: "missed",
      direction: "inbound",
    },
    {
      business,
      createdAt: new Date(+now - 10 * DAY),
      status: "missed",
      direction: "inbound",
    },
    {
      business,
      createdAt: new Date(+now - 190 * DAY),
      status: "missed",
      direction: "inbound",
    },
  ]);
  const row = await refreshBusinessReport(business, now);
  expect(row.windows[7].calls).toBe(1);
  expect(row.windows.previous7.calls).toBe(1);
  expect(row.windows[30].calls).toBe(2);
});
test("company expense overrides are auditable and never modify customer billing", async () => {
  const payload = {
    provider: "ngrok",
    period: "2026-09",
    amountCents: 1000,
    basis: "estimated",
    fixedMonthly: true,
    recurring: true,
    reference: "Monthly plan",
  };
  const result = await request(app)
    .put("/admin/expenses")
    .set("Authorization", `Bearer ${token}`)
    .send(payload);
  expect(result.status).toBe(200);
  expect(
    await AdminActionLog.countDocuments({ action: "update_company_expense" }),
  ).toBe(1);
  expect((await Subscription.findOne({ business })).priceMonthly).toBe(99);
  const summary = await founderOverview(30);
  expect(
    summary.companyExpenses.providers.find((p) => p.provider === "ngrok")
      .amountCents,
  ).toBe(1000);
});

test("company expenses replace monthly totals, carry recurring rules, and restore provider data", async () => {
  const period = new Date().toISOString().slice(0, 7);
  const body = {
    provider: "ngrok",
    period,
    amountCents: 2000,
    basis: "estimated",
    fixedMonthly: true,
    recurring: true,
    reference: "Monthly plan",
  };
  for (const amountCents of [2000, 2500]) {
    const response = await request(app)
      .put("/admin/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...body, amountCents });
    expect(response.status).toBe(200);
  }
  expect(
    await AdminCompanyExpense.countDocuments({
      provider: "ngrok",
      period,
      entrySource: "manual",
    }),
  ).toBe(1);
  expect(
    (await AdminExpenseRule.findOne({ provider: "ngrok" })).amountCents,
  ).toBe(2500);
  const response = await request(app)
    .delete(`/admin/expenses/ngrok/${period}/manual`)
    .set("Authorization", `Bearer ${token}`);
  expect(response.status).toBe(200);
  expect(
    await AdminCompanyExpense.countDocuments({
      provider: "ngrok",
      entrySource: "manual",
    }),
  ).toBe(0);
  expect((await AdminExpenseRule.findOne({ provider: "ngrok" })).enabled).toBe(
    false,
  );
});
test("missing tax-free invoice allocation cannot produce a margin", () => {
  const result = invoiceTotals(
    [
      {
        livemode: true,
        currency: "usd",
        status: "paid",
        recurring: true,
        amountPaidCents: 1000,
        paidAt: new Date("2026-09-02"),
        periodStart: new Date("2026-09-01"),
        periodEnd: new Date("2026-10-01"),
      },
    ],
    new Date("2026-09-01"),
    now,
  );
  expect(result.cashCents).toBe(1000);
  expect(result.allocatedCents).toBeNull();
});
