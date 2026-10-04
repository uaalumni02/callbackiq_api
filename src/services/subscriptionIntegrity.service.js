import { invoiceSubscriptionId } from "../helpers/billing/invoiceSubscriptionId.js";
import { safeConsole } from "../helpers/logging/safeLogger.js";
import Subscription from "../models/subscription.js";
import BillingAnomaly from "../models/billingAnomaly.js";
import { getStripeClient } from "../helpers/stripe/stripeClient.js";

export const LIVE_STRIPE_SUBSCRIPTION_STATUSES = Object.freeze([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

const liveStatusSet = new Set(LIVE_STRIPE_SUBSCRIPTION_STATUSES);

const lifecycleError = (code, message, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const stripeId = (value) =>
  typeof value === "string" ? value : String(value?.id || "");

const normalizeStatus = (value) => String(value || "").toLowerCase();

export const isStripeSubscriptionLive = (subscriptionOrStatus) => {
  const status =
    typeof subscriptionOrStatus === "string"
      ? subscriptionOrStatus
      : subscriptionOrStatus?.status;
  return liveStatusSet.has(normalizeStatus(status));
};

const safeDetails = (details = {}) => {
  try {
    return JSON.parse(JSON.stringify(details));
  } catch (_error) {
    return { note: "Billing anomaly details could not be serialized." };
  }
};

export const recordBillingAnomaly = async ({
  businessId = null,
  type,
  severity = "critical",
  stripeCustomerId = "",
  canonicalSubscriptionId = "",
  observedSubscriptionId = "",
  invoiceId = "",
  eventId = "",
  source = "",
  dedupeKey,
  details = {},
}) => {
  if (!type || !dedupeKey) return null;

  const now = new Date();
  const payload = {
    business: businessId || null,
    type,
    severity,
    status: "open",
    stripeCustomerId: String(stripeCustomerId || ""),
    canonicalSubscriptionId: String(canonicalSubscriptionId || ""),
    observedSubscriptionId: String(observedSubscriptionId || ""),
    invoiceId: String(invoiceId || ""),
    eventId: String(eventId || ""),
    source: String(source || ""),
    details: safeDetails(details),
    lastSeenAt: now,
    resolvedAt: null,
  };

  try {
    const anomaly = await BillingAnomaly.findOneAndUpdate(
      { dedupeKey },
      {
        $setOnInsert: {
          dedupeKey,
          firstSeenAt: now,
        },
        $set: payload,
        $inc: { occurrences: 1 },
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: false,
      },
    );

    safeConsole.error("[billing-anomaly]", {
      type,
      severity,
      businessId: businessId ? String(businessId) : "",
      stripeCustomerId: String(stripeCustomerId || ""),
      canonicalSubscriptionId: String(canonicalSubscriptionId || ""),
      observedSubscriptionId: String(observedSubscriptionId || ""),
      invoiceId: String(invoiceId || ""),
      source,
      dedupeKey,
    });

    return anomaly;
  } catch (error) {
    // Billing protection must fail closed even if anomaly persistence itself fails.
    safeConsole.error("Failed to persist billing anomaly:", error);
    return null;
  }
};

export const listLiveStripeSubscriptions = async ({
  stripe = getStripeClient(),
  stripeCustomerId,
}) => {
  if (!stripeCustomerId) return [];
  if (!stripe?.subscriptions?.list) {
    throw lifecycleError(
      "STRIPE_SUBSCRIPTION_LIST_UNAVAILABLE",
      "Stripe subscription verification is unavailable. Billing changes are temporarily disabled.",
      503,
    );
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 100,
  });

  return (Array.isArray(subscriptions?.data) ? subscriptions.data : []).filter(
    isStripeSubscriptionLive,
  );
};

export const findExistingStripeCustomerForBusiness = async ({
  stripe = getStripeClient(),
  businessId,
}) => {
  if (!businessId || !stripe?.customers?.search) return null;

  const result = await stripe.customers.search({
    query: `metadata['businessId']:'${String(businessId)}'`,
    limit: 10,
  });

  const matches = (Array.isArray(result?.data) ? result.data : []).filter(
    (customer) =>
      String(customer?.metadata?.businessId || "") === String(businessId),
  );

  if (matches.length > 1) {
    await recordBillingAnomaly({
      businessId,
      type: "multiple_stripe_customers_for_business",
      severity: "critical",
      source: "checkout_preflight",
      dedupeKey: `multiple-stripe-customers:${String(businessId)}`,
      details: { stripeCustomerIds: matches.map((item) => item.id) },
    });
    throw lifecycleError(
      "MULTIPLE_STRIPE_CUSTOMERS",
      "Multiple Stripe customer records exist for this business. Billing changes are blocked until the records are reconciled.",
      409,
    );
  }

  return matches[0] || null;
};

export const assertStripeCustomerHasNoCompetingSubscriptions = async ({
  stripe = getStripeClient(),
  business,
  existingSubscription = null,
  stripeCustomerId,
}) => {
  const liveSubscriptions = await listLiveStripeSubscriptions({
    stripe,
    stripeCustomerId,
  });

  if (liveSubscriptions.length === 0) return [];

  const businessId = business?._id || business;
  const canonicalSubscriptionId = String(
    existingSubscription?.stripeSubscriptionId || "",
  );
  const liveSubscriptionIds = liveSubscriptions.map((item) => item.id);

  await recordBillingAnomaly({
    businessId,
    type:
      liveSubscriptions.length > 1
        ? "multiple_live_stripe_subscriptions"
        : "stripe_subscription_exists_before_checkout",
    severity: "critical",
    stripeCustomerId,
    canonicalSubscriptionId,
    observedSubscriptionId: liveSubscriptionIds.join(","),
    source: "checkout_preflight",
    dedupeKey: `checkout-live-subscriptions:${String(businessId)}:${liveSubscriptionIds
      .slice()
      .sort()
      .join("|")}`,
    details: { liveSubscriptionIds },
  });

  throw lifecycleError(
    liveSubscriptions.length > 1
      ? "DUPLICATE_STRIPE_SUBSCRIPTIONS"
      : "STRIPE_SUBSCRIPTION_ALREADY_EXISTS",
    liveSubscriptions.length > 1
      ? "Multiple live Stripe subscriptions were found for this business. New checkout is blocked until billing is reconciled."
      : "Stripe already has a live subscription for this business. New checkout is blocked to prevent duplicate billing.",
    409,
  );
};

export const assertCanonicalIsOnlyLiveSubscription = async ({
  stripe = getStripeClient(),
  subscription,
  source = "canonical_action",
}) => {
  if (!subscription?.stripeCustomerId || !subscription?.stripeSubscriptionId) {
    throw lifecycleError(
      "CANONICAL_STRIPE_SUBSCRIPTION_REQUIRED",
      "A canonical Stripe subscription is required for this billing action.",
      409,
    );
  }

  const liveSubscriptions = await listLiveStripeSubscriptions({
    stripe,
    stripeCustomerId: subscription.stripeCustomerId,
  });
  const canonicalId = String(subscription.stripeSubscriptionId);
  const competing = liveSubscriptions.filter(
    (item) => String(item.id) !== canonicalId,
  );

  if (competing.length > 0) {
    const competingIds = competing.map((item) => item.id);
    await recordBillingAnomaly({
      businessId: subscription.business,
      type: "multiple_live_stripe_subscriptions",
      severity: "critical",
      stripeCustomerId: subscription.stripeCustomerId,
      canonicalSubscriptionId: canonicalId,
      observedSubscriptionId: competingIds.join(","),
      source,
      dedupeKey: `canonical-competing:${canonicalId}:${competingIds
        .slice()
        .sort()
        .join("|")}`,
      details: {
        canonicalSubscriptionId: canonicalId,
        liveSubscriptionIds: liveSubscriptions.map((item) => item.id),
      },
    });
    throw lifecycleError(
      "DUPLICATE_STRIPE_SUBSCRIPTIONS",
      "Multiple live Stripe subscriptions exist for this business. Billing changes are blocked until the duplicates are reconciled.",
      409,
    );
  }

  const canonicalRemote = liveSubscriptions.find(
    (item) => String(item.id) === canonicalId,
  );
  if (!canonicalRemote) {
    await recordBillingAnomaly({
      businessId: subscription.business,
      type: "canonical_subscription_not_live",
      severity: "critical",
      stripeCustomerId: subscription.stripeCustomerId,
      canonicalSubscriptionId: canonicalId,
      source,
      dedupeKey: `canonical-not-live:${canonicalId}`,
      details: { liveSubscriptionIds: liveSubscriptions.map((item) => item.id) },
    });
    throw lifecycleError(
      "CANONICAL_STRIPE_SUBSCRIPTION_NOT_LIVE",
      "The tracked Stripe subscription is no longer live. Billing changes are blocked until the subscription is reconciled.",
      409,
    );
  }

  return canonicalRemote;
};

const retrieveCanonicalSafely = async ({ stripe, canonicalId }) => {
  try {
    return await stripe.subscriptions.retrieve(canonicalId);
  } catch (error) {
    if (error?.code === "resource_missing" || error?.statusCode === 404) {
      return null;
    }
    throw error;
  }
};

export const guardCanonicalStripeSubscription = async ({
  stripe = getStripeClient(),
  businessId,
  incomingStripeSubscription,
  source = "stripe_subscription_sync",
}) => {
  const observedId = stripeId(incomingStripeSubscription);
  if (!businessId || !observedId) {
    return { allowed: true, current: null };
  }

  const current = await Subscription.findOne({ business: businessId });
  const canonicalId = String(current?.stripeSubscriptionId || "");
  if (!canonicalId || canonicalId === observedId) {
    return { allowed: true, current };
  }

  const canonical = await retrieveCanonicalSafely({ stripe, canonicalId });
  if (!canonical || !isStripeSubscriptionLive(canonical)) {
    /*
     * A truly terminal/missing canonical may be replaced only by a NEW LIVE
     * subscription. A late deleted/canceled event from some other old sub must
     * never become canonical.
     */
    if (isStripeSubscriptionLive(incomingStripeSubscription)) {
      return { allowed: true, current, canonical };
    }

    await recordBillingAnomaly({
      businessId,
      type: "foreign_terminal_subscription_webhook",
      severity: "warning",
      stripeCustomerId:
        stripeId(incomingStripeSubscription?.customer) || current?.stripeCustomerId,
      canonicalSubscriptionId: canonicalId,
      observedSubscriptionId: observedId,
      source,
      dedupeKey: `foreign-terminal-webhook:${String(businessId)}:${canonicalId}:${observedId}`,
      details: {
        canonicalStatus: canonical?.status || "missing",
        observedStatus: incomingStripeSubscription?.status || "",
      },
    });
    return { allowed: false, current, canonical };
  }

  await recordBillingAnomaly({
    businessId,
    type: "competing_subscription_webhook",
    severity: "critical",
    stripeCustomerId:
      stripeId(incomingStripeSubscription?.customer) || current?.stripeCustomerId,
    canonicalSubscriptionId: canonicalId,
    observedSubscriptionId: observedId,
    source,
    dedupeKey: `competing-webhook:${String(businessId)}:${canonicalId}:${observedId}`,
    details: {
      canonicalStatus: canonical.status,
      observedStatus: incomingStripeSubscription?.status || "",
    },
  });

  return { allowed: false, current, canonical };
};

export const guardInvoiceAgainstCanonicalSubscription = async ({
  invoice,
  eventId = "",
  source = "invoice_webhook",
}) => {
  const observedSubscriptionId = invoiceSubscriptionId(invoice);
  if (!observedSubscriptionId) {
    return { allowed: false, subscription: null };
  }

  const stripeCustomerId = stripeId(invoice?.customer);
  const subscription = stripeCustomerId
    ? await Subscription.findOne({ stripeCustomerId })
    : await Subscription.findOne({ stripeSubscriptionId: observedSubscriptionId });

  if (!subscription?.stripeSubscriptionId) {
    return { allowed: true, subscription };
  }

  const canonicalSubscriptionId = String(subscription.stripeSubscriptionId);
  if (canonicalSubscriptionId !== observedSubscriptionId) {
    await recordBillingAnomaly({
      businessId: subscription.business,
      type: "invoice_subscription_mismatch",
      severity: "critical",
      stripeCustomerId: stripeCustomerId || subscription.stripeCustomerId,
      canonicalSubscriptionId,
      observedSubscriptionId,
      invoiceId: invoice?.id || "",
      eventId,
      source,
      dedupeKey: `invoice-mismatch:${invoice?.id || "unknown"}:${canonicalSubscriptionId}:${observedSubscriptionId}`,
      details: {
        billingReason: invoice?.billing_reason || "",
        amountPaid: invoice?.amount_paid || 0,
        amountDue: invoice?.amount_due || 0,
      },
    });
    return { allowed: false, subscription };
  }

  if (
    invoice?.billing_reason === "subscription_update" &&
    Number(invoice?.amount_paid || invoice?.amount_due || 0) > 0
  ) {
    await recordBillingAnomaly({
      businessId: subscription.business,
      type: "paid_subscription_update_invoice",
      severity: "warning",
      stripeCustomerId: stripeCustomerId || subscription.stripeCustomerId,
      canonicalSubscriptionId,
      observedSubscriptionId,
      invoiceId: invoice?.id || "",
      eventId,
      source,
      dedupeKey: `paid-subscription-update:${invoice?.id || observedSubscriptionId}`,
      details: {
        billingReason: invoice?.billing_reason,
        amountPaid: invoice?.amount_paid || 0,
        amountDue: invoice?.amount_due || 0,
      },
    });
  }

  return { allowed: true, subscription };
};

export const reconcileStripeSubscriptionIntegrity = async ({
  stripe = getStripeClient(),
} = {}) => {
  if (!stripe?.subscriptions?.list) {
    throw lifecycleError(
      "STRIPE_SUBSCRIPTION_LIST_UNAVAILABLE",
      "Stripe subscription reconciliation is unavailable.",
      503,
    );
  }

  const subscriptions = await Subscription.find({
    stripeCustomerId: { $nin: [null, ""] },
  }).lean();

  const summary = {
    scanned: 0,
    clean: 0,
    anomalies: 0,
    multipleLive: 0,
    canonicalMismatch: 0,
    canonicalMissing: 0,
    errors: 0,
  };

  for (const subscription of subscriptions) {
    summary.scanned += 1;
    try {
      const liveSubscriptions = await listLiveStripeSubscriptions({
        stripe,
        stripeCustomerId: subscription.stripeCustomerId,
      });
      const liveIds = liveSubscriptions.map((item) => item.id);
      const canonicalId = String(subscription.stripeSubscriptionId || "");

      if (liveSubscriptions.length > 1) {
        summary.anomalies += 1;
        summary.multipleLive += 1;
        await recordBillingAnomaly({
          businessId: subscription.business,
          type: "multiple_live_stripe_subscriptions",
          severity: "critical",
          stripeCustomerId: subscription.stripeCustomerId,
          canonicalSubscriptionId: canonicalId,
          observedSubscriptionId: liveIds.join(","),
          source: "daily_reconciliation",
          dedupeKey: `daily-multiple-live:${subscription.stripeCustomerId}:${liveIds
            .slice()
            .sort()
            .join("|")}`,
          details: { liveSubscriptionIds: liveIds },
        });
        continue;
      }

      if (liveSubscriptions.length === 1 && canonicalId !== liveIds[0]) {
        summary.anomalies += 1;
        summary.canonicalMismatch += 1;
        await recordBillingAnomaly({
          businessId: subscription.business,
          type: "canonical_subscription_mismatch",
          severity: "critical",
          stripeCustomerId: subscription.stripeCustomerId,
          canonicalSubscriptionId: canonicalId,
          observedSubscriptionId: liveIds[0],
          source: "daily_reconciliation",
          dedupeKey: `daily-canonical-mismatch:${subscription.stripeCustomerId}:${canonicalId}:${liveIds[0]}`,
          details: { liveSubscriptionIds: liveIds },
        });
        continue;
      }

      if (
        liveSubscriptions.length === 0 &&
        canonicalId &&
        isStripeSubscriptionLive(subscription.status)
      ) {
        summary.anomalies += 1;
        summary.canonicalMissing += 1;
        await recordBillingAnomaly({
          businessId: subscription.business,
          type: "canonical_subscription_missing_from_live_stripe",
          severity: "critical",
          stripeCustomerId: subscription.stripeCustomerId,
          canonicalSubscriptionId: canonicalId,
          source: "daily_reconciliation",
          dedupeKey: `daily-canonical-missing:${subscription.stripeCustomerId}:${canonicalId}`,
          details: { localStatus: subscription.status },
        });
        continue;
      }

      summary.clean += 1;
    } catch (error) {
      summary.errors += 1;
      safeConsole.error("Stripe subscription integrity reconciliation failed:", {
        businessId: String(subscription.business || ""),
        stripeCustomerId: subscription.stripeCustomerId,
        error: error?.message || error,
      });
    }
  }

  return summary;
};

export default {
  LIVE_STRIPE_SUBSCRIPTION_STATUSES,
  isStripeSubscriptionLive,
  recordBillingAnomaly,
  listLiveStripeSubscriptions,
  findExistingStripeCustomerForBusiness,
  assertStripeCustomerHasNoCompetingSubscriptions,
  assertCanonicalIsOnlyLiveSubscription,
  guardCanonicalStripeSubscription,
  guardInvoiceAgainstCanonicalSubscription,
  reconcileStripeSubscriptionIntegrity,
};
