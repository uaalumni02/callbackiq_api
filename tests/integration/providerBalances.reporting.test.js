import {
  normalizeTwilioBalance,
  normalizeStripeBalance,
  describeBalance,
  syncProviderBalances,
  runProviderBalanceSync,
  queueBalanceSync,
} from "../../src/services/admin/providerBalances.service.js";
import { AdminReportingState } from "../../src/models/adminReporting.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";
const now = new Date("2026-09-08T12:00:00Z");
beforeAll(connectTestDB, 120000);
afterEach(clearTestDB);
afterAll(closeTestDB);
test("Twilio preserves real zero and negative balances without treating missing data as zero", () => {
  expect(
    normalizeTwilioBalance({ balance: "0.000", currency: "USD" }).amounts[0]
      .amountCents,
  ).toBe(0);
  expect(
    normalizeTwilioBalance({ balance: "-2.345", currency: "USD" }).amounts[0]
      .amountCents,
  ).toBe(-235);
  for (const balance of [null, "", "NaN", undefined])
    expect(() =>
      normalizeTwilioBalance({ balance, currency: "USD" }),
    ).toThrow();
  expect(() =>
    normalizeTwilioBalance({ balance: "300", currency: "JPY" }),
  ).toThrow();
});
test("Stripe available and pending funds remain separate and test-mode balances are rejected", () => {
  const value = {
    livemode: true,
    available: [{ currency: "usd", amount: 12000 }],
    pending: [{ currency: "usd", amount: 5000 }],
  };
  expect(normalizeStripeBalance(value)).toMatchObject({
    kind: "payout",
    amounts: [{ currency: "usd", amountCents: 12000, pendingCents: 5000 }],
  });
  expect(() => normalizeStripeBalance({ ...value, livemode: false })).toThrow();
  expect(() =>
    normalizeStripeBalance({
      ...value,
      available: [{ currency: "jpy", amount: 50 }],
    }),
  ).toThrow();
  expect(
    normalizeStripeBalance({ ...value, available: [] }).amounts[0].amountCents,
  ).toBeNull();
});
test("manual snapshots do not subtract spending or turn missing balances into zero", () => {
  const data = {
    kind: "prepaid",
    asOf: now,
    amounts: [{ currency: "usd", amountCents: 500 }],
  };
  expect(describeBalance("openai", null, null, now).status).toBe("unavailable");
  expect(describeBalance("openai", null, data, now)).toMatchObject({
    status: "low",
    source: "manual",
    amounts: data.amounts,
  });
  expect(
    describeBalance(
      "openai",
      null,
      { ...data, asOf: new Date(+now - 8 * 86400000) },
      now,
    ).status,
  ).toBe("stale");
  expect(
    describeBalance(
      "ngrok",
      null,
      { ...data, kind: "amount_due", dueAt: new Date(+now - 86400000) },
      now,
    ).status,
  ).toBe("overdue");
  expect(
    describeBalance(
      "twilio",
      { ...data, errorCode: "BALANCE_SYNC_FAILED" },
      null,
      now,
    ).status,
  ).toBe("stale");
});
test("failed refresh retains last successful balance and does not overwrite a manual record", async () => {
  const good = normalizeTwilioBalance({ balance: "25", currency: "USD" });
  await syncProviderBalances({ now, readers: { twilio: async () => good } });
  await AdminReportingState.create({
    _id: "provider-balance:twilio:manual",
    data: { asOf: now, amounts: [{ currency: "usd", amountCents: 9900 }] },
  });
  await syncProviderBalances({
    now: new Date(+now + 1000),
    readers: {
      twilio: async () => {
        throw Object.assign(new Error("secret provider details"), {
          status: 403,
        });
      },
    },
  });
  const row = await AdminReportingState.findById(
    "provider-balance:twilio:provider",
  );
  expect(row.data.amounts[0].amountCents).toBe(2500);
  expect(row.data.errorCode).toBe("BALANCE_ACCESS_DENIED");
  expect(JSON.stringify(row)).not.toContain("secret provider details");
  expect(
    (await AdminReportingState.findById("provider-balance:twilio:manual")).data
      .amounts[0].amountCents,
  ).toBe(9900);
});
test("refresh request does not bypass an active balance-sync lease", async () => {
  await AdminReportingState.create({
    _id: "provider-balance-sync",
    data: {
      nextAt: new Date(0),
      leaseUntil: new Date(Date.now() + 60000),
      token: "existing",
    },
  });
  await queueBalanceSync();
  await runProviderBalanceSync();
  expect(
    await AdminReportingState.countDocuments({
      _id: "provider-balance:twilio:provider",
    }),
  ).toBe(0);
  expect(
    (await AdminReportingState.findById("provider-balance-sync")).data.token,
  ).toBe("existing");
});
