import twilio from "twilio";
import Stripe from "stripe";
import OpenAI from "openai";
import {
  AdminCompanyExpense,
  AdminExpenseRule,
  AdminReportingState,
} from "../../models/adminReporting.js";
const DAY = 86400000;
export const EXPENSE_PROVIDERS = [
  "twilio",
  "openai",
  "stripe",
  "ngrok",
  "hosting",
  "other",
];
export const monthRange = (period, now = new Date()) => {
  const start = new Date(`${period}-01T00:00:00Z`);
  const next = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, end: new Date(Math.min(+next, +today)), next };
};
const strictMoney = (value, currency) => {
  if (
    currency !== "usd" ||
    value == null ||
    value === "" ||
    !Number.isFinite(Number(value))
  )
    throw Object.assign(new Error("Unsupported or missing provider amount"), {
      code: "INVALID_PROVIDER_AMOUNT",
    });
  return Number(value);
};
export const fetchTwilioExpense = async (client, range) => {
  // totalprice is authoritative. Category subtotals overlap, so never sum them.
  const records = await client.usage.records.list({
    category: "totalprice",
    startDate: range.start,
    endDate: new Date(+range.end - DAY),
    includeSubaccounts: true,
    limit: 2,
  });
  if (records.length !== 1)
    throw Object.assign(new Error("Missing total usage record"), {
      code: "INCOMPLETE_PROVIDER_DATA",
    });
  const r = records[0];
  return {
    amountCents: Math.round(strictMoney(r.price, r.priceUnit) * 100),
    providerAsOf: r.asOf || null,
    details: { usageCategory: "totalprice" },
  };
};
export const stripeTransactionFee = (transaction) => {
  strictMoney(transaction.fee, transaction.currency);
  // Standalone Stripe fee debits are amounts, not processing-fee fields. Use
  // net once for these entries; all other entries contribute their fee only.
  if (
    ["stripe_fee", "stripe_fx_fee", "tax_fee", "fee_credit_funding"].includes(
      transaction.type,
    )
  )
    return -strictMoney(transaction.net, transaction.currency);
  return Number(transaction.fee);
};
export const fetchStripeExpense = async (client, range) => {
  let after,
    total = 0,
    transactions = 0;
  for (let page = 0; page < 100; page++) {
    const response = await client.balanceTransactions.list({
      created: {
        gte: Math.floor(+range.start / 1000),
        lt: Math.floor(+range.end / 1000),
      },
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const transaction of response.data) {
      total += stripeTransactionFee(transaction);
      transactions++;
    }
    if (!response.has_more)
      return { amountCents: total, details: { transactions } };
    if (!response.data.length) break;
    after = response.data.at(-1).id;
  }
  throw Object.assign(new Error("Stripe pagination limit reached"), {
    code: "INCOMPLETE_PROVIDER_DATA",
  });
};
export const fetchOpenAiExpense = async (client, range, projectIds = []) => {
  let page,
    total = 0,
    buckets = 0;
  const seen = new Set();
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await client.admin.organization.usage.costs({
      start_time: Math.floor(+range.start / 1000),
      end_time: Math.floor(+range.end / 1000),
      bucket_width: "1d",
      limit: 31,
      ...(projectIds.length ? { project_ids: projectIds } : {}),
      ...(page ? { page } : {}),
    });
    for (const bucket of response.data) {
      const key = `${bucket.start_time}:${bucket.end_time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets++;
      for (const result of bucket.results)
        total += strictMoney(result.amount?.value, result.amount?.currency);
    }
    if (!response.has_more)
      return {
        amountCents: Math.round(total * 100),
        details: { buckets, projectFiltered: projectIds.length > 0 },
      };
    if (!response.next_page || response.next_page === page) break;
    page = response.next_page;
  }
  throw Object.assign(new Error("OpenAI pagination limit reached"), {
    code: "INCOMPLETE_PROVIDER_DATA",
  });
};
const providerReaders = () => {
  const readers = {};
  const sid =
    process.env.TWILIO_COST_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
  const username =
    process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID;
  const password =
    process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
  if (sid && username && password)
    readers.twilio = {
      read: (range) =>
        fetchTwilioExpense(
          twilio(username, password, {
            accountSid: sid,
            timeout: 10000,
            autoRetry: false,
          }),
          range,
        ),
      scope: "Configured Twilio account, including subaccounts",
    };
  if (
    process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ||
    process.env.STRIPE_SECRET_KEY?.startsWith("rk_live_")
  )
    readers.stripe = {
      read: (range) =>
        fetchStripeExpense(
          new Stripe(process.env.STRIPE_SECRET_KEY, {
            timeout: 10000,
            maxNetworkRetries: 0,
          }),
          range,
        ),
      scope: "Configured live Stripe account",
    };
  if (process.env.OPENAI_ADMIN_KEY) {
    const projectIds = (process.env.OPENAI_COST_PROJECT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const client = new OpenAI({
      apiKey: process.env.OPENAI_ADMIN_KEY,
      adminAPIKey: process.env.OPENAI_ADMIN_KEY,
      timeout: 10000,
      maxRetries: 0,
    });
    readers.openai = {
      read: (range) => fetchOpenAiExpense(client, range, projectIds),
      scope: projectIds.length
        ? "Selected OpenAI projects"
        : "Entire OpenAI organization",
    };
  }
  return readers;
};
export const syncCompanyExpenses = async ({
  now = new Date(),
  readers = providerReaders(),
  force = false,
} = {}) => {
  const periods = [
    now.toISOString().slice(0, 7),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7),
  ];
  for (const provider of ["twilio", "openai", "stripe"]) {
    for (const period of periods) {
      const key = { provider, period, entrySource: "provider" };
      const previous = await AdminCompanyExpense.findOne(key).lean();
      if (
        !force &&
        previous?.lastAttemptAt &&
        now - new Date(previous.lastAttemptAt) < 6 * 3600000
      )
        continue;
      const range = monthRange(period, now);
      if (!readers[provider]) {
        await AdminCompanyExpense.updateOne(
          key,
          {
            $set: {
              lastAttemptAt: now,
              errorCode: "COST_ACCESS_NOT_CONFIGURED",
            },
            $setOnInsert: { basis: "provider_reported", complete: false },
          },
          { upsert: true },
        );
        continue;
      }
      try {
        const amount =
          range.end <= range.start
            ? { amountCents: 0, details: { noCompletedDays: true } }
            : await readers[provider].read(range);
        await AdminCompanyExpense.updateOne(
          key,
          {
            $set: {
              ...amount,
              basis: "provider_reported",
              fixedMonthly: false,
              complete: true,
              currency: "usd",
              throughDate: range.end,
              syncedAt: now,
              lastAttemptAt: now,
              errorCode: "",
              scope: readers[provider].scope,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        // Never return raw provider errors: they can contain request headers.
        const code = [401, 403].includes(error.status)
          ? "COST_ACCESS_DENIED"
          : "COST_SYNC_FAILED";
        await AdminCompanyExpense.updateOne(
          key,
          {
            $set: { lastAttemptAt: now, errorCode: code },
            $setOnInsert: { basis: "provider_reported", complete: false },
          },
          { upsert: true },
        );
      }
    }
  }
};
export const companyExpenseSummary = async (now = new Date()) => {
  const period = now.toISOString().slice(0, 7),
    previousPeriod = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    )
      .toISOString()
      .slice(0, 7);
  const [records, rules] = await Promise.all([
    AdminCompanyExpense.find({ period: { $in: [period, previousPeriod] } })
      .select("-updatedBy")
      .lean(),
    AdminExpenseRule.find({}).select("-updatedBy").lean(),
  ]);
  const choose = (provider, month) => {
    const manual = records.find(
      (r) =>
        r.provider === provider &&
        r.period === month &&
        r.entrySource === "manual",
    );
    const automatic = records.find(
      (r) =>
        r.provider === provider &&
        r.period === month &&
        r.entrySource === "provider",
    );
    const rule = rules.find(
      (r) => r.provider === provider && r.enabled && r.effectiveFrom <= month,
    );
    const record =
      manual ||
      (rule
        ? {
            amountCents: rule.amountCents,
            fixedMonthly: true,
            basis: "estimated",
            complete: true,
            reference: rule.reference,
            entrySource: "recurring",
          }
        : automatic);
    if (!record)
      return { provider, amountCents: null, basis: "missing", complete: false };
    const currentRange = monthRange(month, now);
    const elapsed = Math.max(0, (currentRange.end - currentRange.start) / DAY),
      totalDays = (currentRange.next - currentRange.start) / DAY;
    const stale =
      record.entrySource === "provider" &&
      (!record.syncedAt ||
        now - new Date(record.syncedAt) > 12 * 3600000 ||
        Boolean(record.errorCode));
    return {
      provider,
      amountCents: record.amountCents ?? null,
      basis: record.basis,
      complete: Boolean(record.complete && !stale),
      stale,
      errorCode: record.errorCode || null,
      throughDate: record.throughDate || null,
      providerAsOf: record.providerAsOf || null,
      syncedAt: record.syncedAt || null,
      scope: record.scope || "Entered company expense",
      fixedMonthly: Boolean(record.fixedMonthly),
      reference: record.reference || "",
      forecastCents:
        record.amountCents == null || stale
          ? null
          : record.fixedMonthly
            ? record.amountCents
            : elapsed >= 3
              ? Math.round((record.amountCents / elapsed) * totalDays)
              : null,
      budgetCents:
        rules.find((r) => r.provider === provider)?.budgetCents ?? null,
    };
  };
  const providers = EXPENSE_PROVIDERS.map((provider) => ({
    ...choose(provider, period),
    previous: choose(provider, previousPeriod),
  }));
  const complete = providers.every((p) => p.complete && p.amountCents !== null);
  const knownCents = providers.reduce((s, p) => s + (p.amountCents || 0), 0);
  const forecastComplete = providers.every(
    (p) => p.complete && p.forecastCents !== null,
  );
  return {
    period,
    previousPeriod,
    providers,
    complete,
    knownCents,
    totalCents: complete ? knownCents : null,
    forecastCents: forecastComplete
      ? providers.reduce((s, p) => s + p.forecastCents, 0)
      : null,
    note: "Company expense totals are separate from customer cost allocations. Usage APIs can lag final invoices. Forecast extrapolates completed days after day 3; fixed monthly entries are counted once.",
  };
};
// Lease the provider sync across reporting workers. Costs never block customer
// reporting; this job has a separate timer and retains its last successful data.
export const runCompanyExpenseSync = async () => {
  const now = new Date();
  const key = "company-cost-sync";
  try {
    await AdminReportingState.updateOne(
      { _id: key },
      { $setOnInsert: { data: { nextAt: new Date(0) } } },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const claimed = await AdminReportingState.findOneAndUpdate(
    {
      _id: key,
      "data.nextAt": { $lte: now },
      $or: [
        { "data.leaseUntil": { $exists: false } },
        { "data.leaseUntil": { $lte: now } },
      ],
    },
    {
      $set: {
        "data.nextAt": new Date(+now + 6 * 3600000),
        "data.leaseUntil": new Date(+now + 3600000),
      },
    },
    { returnDocument: "after" },
  );
  if (claimed) {
    try {
      await syncCompanyExpenses({ now });
    } finally {
      await AdminReportingState.updateOne(
        { _id: key, "data.leaseUntil": new Date(+now + 3600000) },
        { $unset: { "data.leaseUntil": "" } },
      );
    }
  }
};
