import Stripe from "stripe";
import Subscription from "../../models/subscription.js";
import {
  AdminBillingFact,
  AdminReportingState,
} from "../../models/adminReporting.js";
const fromUnix = (n) =>
  Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
const stripeId = (value) =>
  typeof value === "string" ? value : value?.id || "";
export const normalizeReportingInvoice = (
  invoice,
  business,
  now = new Date(),
) => {
  const recurringLines = (invoice.lines?.data || []).filter(
    (line) =>
      line.type === "subscription" ||
      line.parent?.subscription_item_details ||
      line.subscription,
  );
  const starts = recurringLines
    .map((l) => l.period?.start)
    .filter(Number.isFinite);
  const ends = recurringLines.map((l) => l.period?.end).filter(Number.isFinite);
  const taxFree = invoice.total_excluding_tax;
  // Keep gross cash separate from the management allocation used for margin.
  const allocatable =
    Number.isFinite(taxFree) && invoice.total > 0
      ? Math.round(
          (Math.max(0, invoice.amount_paid || 0) * Math.max(0, taxFree)) /
            invoice.total,
        )
      : null;
  return {
    business,
    invoiceId: invoice.id,
    subscriptionId: stripeId(
      invoice.subscription ||
        invoice.parent?.subscription_details?.subscription,
    ),
    currency: invoice.currency || "",
    livemode: invoice.livemode === true,
    status: invoice.status || "unknown",
    amountPaidCents: Math.max(0, invoice.amount_paid || 0),
    amountRemainingCents: Math.max(0, invoice.amount_remaining || 0),
    allocatableCents: allocatable,
    created: fromUnix(invoice.created),
    paidAt: fromUnix(invoice.status_transitions?.paid_at),
    dueAt:
      fromUnix(invoice.due_date) ||
      (invoice.attempted && invoice.status === "open"
        ? fromUnix(invoice.created)
        : null),
    periodStart: starts.length ? fromUnix(Math.min(...starts)) : null,
    periodEnd: ends.length ? fromUnix(Math.max(...ends)) : null,
    recurring: recurringLines.length > 0 && invoice.lines?.has_more !== true,
    observedAt: now,
  };
};
export const normalizedMonthlyCents = (subscription) => {
  let total = 0;
  if (!subscription.items?.data?.length || subscription.items.has_more)
    return null;
  for (const item of subscription.items.data) {
    const price = item.price;
    const interval = price?.recurring?.interval;
    const count = price?.recurring?.interval_count || 1;
    if (
      price?.currency !== "usd" ||
      price?.recurring?.usage_type === "metered" ||
      price?.unit_amount == null ||
      !["month", "year"].includes(interval)
    )
      return null;
    total +=
      (price.unit_amount * (item.quantity ?? 1)) /
      (interval === "year" ? 12 * count : count);
  }
  // Discounted/tiered subscriptions require an explicit reporting allocation.
  if (subscription.discounts?.length) return null;
  return Math.round(total);
};
export const syncBusinessBillingReport = async (
  business,
  { stripe, now = new Date(), force = false } = {},
) => {
  const current = await AdminReportingState.findById(
    `billing:${business}`,
  ).lean();
  if (
    !force &&
    current?.data?.syncedAt &&
    now - new Date(current.data.syncedAt) < 6 * 3600000
  )
    return current.data;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!stripe) {
    if (!key || process.env.ADMIN_REPORTING_STRIPE_SYNC === "false")
      return current?.data || null;
    stripe = new Stripe(key, { timeout: 10000, maxNetworkRetries: 1 });
  }
  const sub = await Subscription.findOne({ business })
    .select("stripeSubscriptionId")
    .lean();
  if (!sub?.stripeSubscriptionId) return null;
  const providerSub = await stripe.subscriptions.retrieve(
    sub.stripeSubscriptionId,
  );
  let after,
    complete = false,
    count = 0;
  // Bounded pages, keyed by canonical subscription. A retry replaces facts by
  // invoice ID and cannot double-count invoice.paid/payment_succeeded events.
  for (let page = 0; page < 10; page++) {
    const response = await stripe.invoices.list({
      subscription: sub.stripeSubscriptionId,
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const invoice of response.data) {
      const fact = normalizeReportingInvoice(invoice, business, now);
      if (
        fact.subscriptionId &&
        fact.subscriptionId !== sub.stripeSubscriptionId
      )
        continue;
      await AdminBillingFact.updateOne(
        { invoiceId: invoice.id },
        { $set: fact },
        { upsert: true },
      );
      count++;
    }
    if (!response.has_more) {
      complete = true;
      break;
    }
    if (!response.data.length) break;
    after = response.data.at(-1).id;
  }
  const data = {
    syncedAt: now,
    complete: complete && providerSub.livemode === true,
    livemode: providerSub.livemode === true,
    invoiceCount: count,
    monthlyCents: normalizedMonthlyCents(providerSub),
    status: providerSub.status,
    cancellationReason:
      providerSub.cancellation_details?.feedback ||
      providerSub.cancellation_details?.reason ||
      "",
    // Refunds and disputes are not silently treated as zero. Margin remains an
    // estimate before refunds; the UI exposes this basis next to the metric.
    revenueBasis:
      "Current subscription paid invoice allocation, excluding tax; before refunds and disputes",
  };
  await AdminReportingState.updateOne(
    { _id: `billing:${business}` },
    { $set: { data } },
    { upsert: true },
  );
  return data;
};
