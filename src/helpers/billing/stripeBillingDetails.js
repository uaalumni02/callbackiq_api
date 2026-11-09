export const toDateFromUnix = (timestamp) => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

const formatStripeMoney = (amount = 0, currency = "usd") => {
  const value = Number(amount || 0) / 100;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(value);
};

export const getDefaultPaymentMethod = () => ({
  brand: "",
  last4: "",
  expMonth: null,
  expYear: null,
  display: "No payment method",
});

export const getDefaultNextCharge = () => ({
  amount: 0,
  currency: "usd",
  display: "$0.00",
  nextPaymentAttempt: null,
});

const formatPaymentMethodType = (type = "") => {
  if (!type) return "Payment Method";

  const labels = {
    card: "Card",
    link: "Link",
    cashapp: "Cash App Pay",
    amazon_pay: "Amazon Pay",
    klarna: "Klarna",
    us_bank_account: "Bank Account",
    sepa_debit: "SEPA Debit",
    acss_debit: "ACSS Debit",
    au_becs_debit: "BECS Debit",
    bacs_debit: "Bacs Debit",
    paypal: "PayPal",
    affirm: "Affirm",
    afterpay_clearpay: "Afterpay / Clearpay",
  };

  return (
    labels[type] ||
    String(type)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
};

const mapStripePaymentMethod = (paymentMethod) => {
  if (!paymentMethod) return getDefaultPaymentMethod();

  if (paymentMethod.card) {
    const card = paymentMethod.card;
    const brand = card.brand
      ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1)
      : "Card";

    return {
      brand,
      type: "card",
      last4: card.last4 || "",
      expMonth: card.exp_month || null,
      expYear: card.exp_year || null,
      display: `${brand} •••• ${card.last4 || "----"}`,
    };
  }

  if (paymentMethod.type === "link") {
    const email =
      paymentMethod.link?.email || paymentMethod.billing_details?.email || "";

    return {
      brand: "Link",
      type: "link",
      last4: "",
      expMonth: null,
      expYear: null,
      display: email ? `Link • ${email}` : "Link",
    };
  }

  if (paymentMethod.type === "cashapp") {
    return {
      brand: "Cash App",
      type: "cashapp",
      last4: "",
      expMonth: null,
      expYear: null,
      display: "Cash App Pay",
    };
  }

  if (paymentMethod.type === "amazon_pay") {
    return {
      brand: "Amazon Pay",
      type: "amazon_pay",
      last4: "",
      expMonth: null,
      expYear: null,
      display: "Amazon Pay",
    };
  }

  if (paymentMethod.type === "klarna") {
    return {
      brand: "Klarna",
      type: "klarna",
      last4: "",
      expMonth: null,
      expYear: null,
      display: "Klarna",
    };
  }

  if (paymentMethod.type === "us_bank_account") {
    return {
      brand: "Bank Account",
      type: "us_bank_account",
      last4: paymentMethod.us_bank_account?.last4 || "",
      expMonth: null,
      expYear: null,
      display: `Bank Account •••• ${
        paymentMethod.us_bank_account?.last4 || "----"
      }`,
    };
  }

  if (paymentMethod.type === "sepa_debit") {
    return {
      brand: "SEPA Debit",
      type: "sepa_debit",
      last4: paymentMethod.sepa_debit?.last4 || "",
      expMonth: null,
      expYear: null,
      display: `SEPA Debit •••• ${paymentMethod.sepa_debit?.last4 || "----"}`,
    };
  }

  const label = formatPaymentMethodType(paymentMethod.type);

  return {
    brand: label,
    type: paymentMethod.type || "",
    last4: "",
    expMonth: null,
    expYear: null,
    display: label,
  };
};

export const getPaymentMethodSummary = async (
  stripe,
  stripeCustomerId,
  stripeSubscriptionId,
) => {
  if (!stripeCustomerId && !stripeSubscriptionId) {
    return getDefaultPaymentMethod();
  }

  try {
    if (stripeSubscriptionId && stripe?.subscriptions?.retrieve) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
        {
          expand: [
            "default_payment_method",
            "latest_invoice",
            "latest_invoice.payment_intent",
            "latest_invoice.payment_intent.payment_method",
          ],
        },
      );

      const subscriptionPaymentMethod =
        stripeSubscription.default_payment_method ||
        stripeSubscription.latest_invoice?.payment_intent?.payment_method;

      if (subscriptionPaymentMethod) {
        return mapStripePaymentMethod(subscriptionPaymentMethod);
      }
    }

    if (stripeCustomerId && stripe?.paymentMethods?.list) {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        limit: 1,
      });

      const paymentMethod = paymentMethods.data?.[0];

      if (paymentMethod) {
        return mapStripePaymentMethod(paymentMethod);
      }
    }

    return getDefaultPaymentMethod();
  } catch (error) {
    return getDefaultPaymentMethod();
  }
};

export const getNextChargeDetails = async (
  stripe,
  stripeCustomerId,
  stripeSubscriptionId,
) => {
  if (!stripeCustomerId && !stripeSubscriptionId) {
    return getDefaultNextCharge();
  }

  try {
    if (stripe?.invoices?.retrieveUpcoming && stripeCustomerId) {
      const upcomingInvoice = await stripe.invoices.retrieveUpcoming({
        customer: stripeCustomerId,
        subscription: stripeSubscriptionId || undefined,
      });

      return {
        amount: upcomingInvoice.amount_due || 0,
        currency: upcomingInvoice.currency || "usd",
        display: formatStripeMoney(
          upcomingInvoice.amount_due || 0,
          upcomingInvoice.currency || "usd",
        ),
        nextPaymentAttempt:
          toDateFromUnix(upcomingInvoice.next_payment_attempt) ||
          toDateFromUnix(upcomingInvoice.period_end),
      };
    }
  } catch (error) {
    // Fall through to subscription fallback below.
  }

  try {
    if (stripeSubscriptionId && stripe?.subscriptions?.retrieve) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
        {
          expand: ["items.data.price"],
        },
      );

      const price = stripeSubscription.items?.data?.[0]?.price;
      const unitAmount = price?.unit_amount || 0;
      const currency = price?.currency || "usd";

      return {
        amount: unitAmount,
        currency,
        display: formatStripeMoney(unitAmount, currency),
        nextPaymentAttempt: toDateFromUnix(
          stripeSubscription.current_period_end,
        ),
      };
    }
  } catch (error) {
    return getDefaultNextCharge();
  }

  return getDefaultNextCharge();
};

export const mapStripeInvoice = (invoice) => ({
  id: invoice.id,
  number: invoice.number || invoice.id,
  status: invoice.status || "unknown",
  amountDue: invoice.amount_due || 0,
  amountPaid: invoice.amount_paid || 0,
  currency: invoice.currency || "usd",
  amountDueDisplay: formatStripeMoney(
    invoice.amount_due || 0,
    invoice.currency || "usd",
  ),
  amountPaidDisplay: formatStripeMoney(
    invoice.amount_paid || 0,
    invoice.currency || "usd",
  ),
  hostedInvoiceUrl: invoice.hosted_invoice_url || "",
  invoicePdf: invoice.invoice_pdf || "",
  createdAt: toDateFromUnix(invoice.created),
  periodStart: toDateFromUnix(invoice.period_start),
  periodEnd: toDateFromUnix(invoice.period_end),
});
