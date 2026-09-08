import crypto from "node:crypto";
import twilio from "twilio";
import Stripe from "stripe";
import { AdminReportingState } from "../../models/adminReporting.js";

export const BALANCE_PROVIDERS = [
  "twilio",
  "openai",
  "stripe",
  "ngrok",
  "hosting",
  "other",
];
const MINUTE = 60000;
const key = (provider, source) => `provider-balance:${provider}:${source}`;
const currency = (value) => {
  if (typeof value !== "string" || !/^[a-z]{3}$/i.test(value))
    throw new Error("Invalid currency");
  return value.toLowerCase();
};
export const normalizeTwilioBalance = (value) => {
  if (value.balance == null || !/^-?\d+(\.\d+)?$/.test(String(value.balance)))
    throw new Error("Missing balance");
  if (currency(value.currency) !== "usd")
    throw Object.assign(new Error("Unsupported balance currency"), {
      code: "UNSUPPORTED_BALANCE_CURRENCY",
    });
  const amountCents = Math.round(Number(value.balance) * 100);
  if (!Number.isSafeInteger(amountCents)) throw new Error("Invalid balance");
  return {
    kind: "prepaid",
    amounts: [{ currency: currency(value.currency), amountCents }],
    scope: "Configured Twilio account balance; shared subaccount funds",
  };
};
export const normalizeStripeBalance = (value) => {
  if (value.livemode !== true)
    throw Object.assign(new Error("Live balance required"), {
      code: "LIVE_BALANCE_REQUIRED",
    });
  if (!Array.isArray(value.available) || !Array.isArray(value.pending))
    throw new Error("Missing balance");
  const rows = new Map();
  for (const [field, entries] of [
    ["amountCents", value.available],
    ["pendingCents", value.pending],
  ]) {
    const seen = new Set();
    for (const entry of entries) {
      const code = currency(entry.currency);
      if (!Number.isSafeInteger(entry.amount) || seen.has(code))
        throw new Error("Invalid balance");
      seen.add(code);
      // Stripe amounts are minor units, which differ across currencies. USD-only
      // automatic display matches the existing expense report; never convert FX.
      if (code !== "usd")
        throw Object.assign(new Error("Unsupported balance currency"), {
          code: "UNSUPPORTED_BALANCE_CURRENCY",
        });
      const row = rows.get(code) || {
        currency: code,
        amountCents: null,
        pendingCents: null,
      };
      row[field] = entry.amount;
      rows.set(code, row);
    }
  }
  if (!rows.size) throw new Error("Missing balance");
  return {
    kind: "payout",
    amounts: [...rows.values()],
    scope:
      "Live Stripe available and pending funds; not prepaid service credit",
  };
};
export const createBalanceReaders = () => {
  const readers = {};
  const sid =
    process.env.TWILIO_COST_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
  const username =
    process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID;
  const password =
    process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
  if (sid && username && password) {
    const client = twilio(username, password, {
      accountSid: sid,
      timeout: 10000,
      autoRetry: false,
    });
    readers.twilio = async () =>
      normalizeTwilioBalance(
        await client.api.v2010.accounts(sid).balance.fetch(),
      );
  }
  const stripeKey =
    process.env.STRIPE_REPORTING_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  if (/^(sk|rk)_live_/.test(stripeKey || "")) {
    const client = new Stripe(stripeKey, {
      timeout: 10000,
      maxNetworkRetries: 0,
    });
    readers.stripe = async () =>
      normalizeStripeBalance(await client.balance.retrieve());
  }
  return readers;
};
export const syncProviderBalances = async ({
  now = new Date(),
  readers = createBalanceReaders(),
  progress = () => {},
} = {}) => {
  return Promise.all(
    ["twilio", "stripe"].map(async (provider) => {
      progress(`${provider}: checking balance`);
      let data;
      try {
        if (!readers[provider])
          throw Object.assign(new Error("Not configured"), {
            code: "BALANCE_ACCESS_NOT_CONFIGURED",
          });
        data = {
          ...(await readers[provider]()),
          asOf: now,
          syncedAt: now,
          lastAttemptAt: now,
          errorCode: null,
        };
      } catch (error) {
        const known = [
          "BALANCE_ACCESS_NOT_CONFIGURED",
          "LIVE_BALANCE_REQUIRED",
          "UNSUPPORTED_BALANCE_CURRENCY",
        ];
        data = {
          lastAttemptAt: now,
          errorCode: known.includes(error.code)
            ? error.code
            : [401, 403].includes(error.status)
              ? "BALANCE_ACCESS_DENIED"
              : "BALANCE_SYNC_FAILED",
        };
      }
      // Failure updates only status, preserving the last successful snapshot.
      await AdminReportingState.updateOne(
        { _id: key(provider, "provider") },
        {
          $set: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [`data.${k}`, v]),
          ),
        },
        { upsert: true },
      );
      progress(`${provider}: ${data.errorCode || "balance updated"}`);
      return { provider, error: data.errorCode };
    }),
  );
};
export const describeBalance = (
  provider,
  automatic,
  manual,
  now = new Date(),
) => {
  const data = manual || automatic;
  const source = manual ? "manual" : "provider";
  const kind =
    data?.kind ||
    (provider === "stripe"
      ? "payout"
      : ["twilio", "openai"].includes(provider)
        ? "prepaid"
        : "amount_due");
  const asOf = data?.asOf ? new Date(data.asOf) : null;
  const validDate = asOf && Number.isFinite(+asOf) && asOf <= now;
  const stale = Boolean(
    data &&
      (!validDate ||
        now - asOf > (source === "manual" ? 7 * 86400000 : 30 * MINUTE) ||
        data.errorCode),
  );
  const amounts = data?.amounts || [];
  const amount = amounts[0]?.amountCents;
  const thresholdCents = data?.thresholdCents ?? 1000;
  const due = data?.dueAt ? new Date(data.dueAt) : null;
  const status =
    amount == null
      ? "unavailable"
      : stale
        ? "stale"
        : kind === "prepaid" && amount <= thresholdCents
          ? "low"
          : kind === "payout" && amount < 0
            ? "negative"
            : kind === "amount_due" && amount > 0 && due && due < now
              ? "overdue"
              : "current";
  return {
    provider,
    kind,
    source: data ? source : null,
    status,
    amounts,
    asOf: validDate ? asOf : null,
    stale,
    thresholdCents,
    dueAt: data?.dueAt || null,
    reference: data?.reference || "",
    errorCode: data?.errorCode || null,
    scope: data?.scope || "Manually verified provider balance",
    manualOverride: Boolean(manual),
    automaticAvailable: Boolean(automatic?.amounts?.length),
  };
};
export const providerBalanceSummary = async (now = new Date()) => {
  const ids = BALANCE_PROVIDERS.flatMap((p) => [
    key(p, "provider"),
    key(p, "manual"),
  ]);
  const records = await AdminReportingState.find({ _id: { $in: ids } })
    .lean()
    .maxTimeMS(5000);
  const rows = new Map(records.map((r) => [r._id, r.data]));
  return BALANCE_PROVIDERS.map((p) =>
    describeBalance(
      p,
      rows.get(key(p, "provider")),
      rows.get(key(p, "manual")),
      now,
    ),
  );
};
export const queueBalanceSync = async () => {
  await AdminReportingState.updateOne(
    { _id: "provider-balance-sync" },
    { $set: { "data.nextAt": new Date(0) } },
    { upsert: true },
  );
};
export const runProviderBalanceSync = async () => {
  const now = new Date(),
    token = crypto.randomUUID();
  try {
    await AdminReportingState.updateOne(
      { _id: "provider-balance-sync" },
      { $setOnInsert: { data: { nextAt: new Date(0) } } },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const claimed = await AdminReportingState.findOneAndUpdate(
    {
      _id: "provider-balance-sync",
      "data.nextAt": { $lte: now },
      $or: [
        { "data.leaseUntil": { $exists: false } },
        { "data.leaseUntil": { $lte: now } },
      ],
    },
    {
      $set: {
        "data.nextAt": new Date(+now + 15 * MINUTE),
        "data.leaseUntil": new Date(+now + 2 * MINUTE),
        "data.token": token,
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return;
  try {
    await syncProviderBalances({ now });
  } finally {
    await AdminReportingState.updateOne(
      { _id: "provider-balance-sync", "data.token": token },
      { $unset: { "data.leaseUntil": "", "data.token": "" } },
    );
  }
};
