import Db from "../db/db.js";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import { checkoutSchema } from "../validator/billing.js";
import {
  getStripeClient,
  getPriceIdByPlan,
} from "../helpers/stripe/stripeClient.js";
import * as Response from "../helpers/response/response.js";

const getClientUrl = () => {
  return process.env.CLIENT_URL || "http://localhost:3001";
};

const toDateFromUnix = (timestamp) => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

const addDays = (date, days) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

const formatStripeMoney = (amount = 0, currency = "usd") => {
  const value = Number(amount || 0) / 100;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(value);
};

const inferPlanFromPriceId = (priceId) => {
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID) return "starter";
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return "pro";
  if (priceId === process.env.STRIPE_AGENCY_PRICE_ID) return "agency";
  return "pro";
};

const getDefaultPaymentMethod = () => ({
  brand: "",
  last4: "",
  expMonth: null,
  expYear: null,
  display: "No payment method",
});

const getDefaultNextCharge = () => ({
  amount: 0,
  currency: "usd",
  display: "$0.00",
  nextPaymentAttempt: null,
});

const mapCardToPaymentMethod = (card) => {
  if (!card) return getDefaultPaymentMethod();

  const brand = card.brand
    ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1)
    : "Card";

  return {
    brand,
    last4: card.last4 || "",
    expMonth: card.exp_month || null,
    expYear: card.exp_year || null,
    display: `${brand} •••• ${card.last4 || "----"}`,
  };
};

const getPaymentMethodSummary = async (
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
            "latest_invoice.payment_intent.payment_method",
          ],
        },
      );

      const subscriptionPaymentMethod =
        stripeSubscription.default_payment_method ||
        stripeSubscription.latest_invoice?.payment_intent?.payment_method;

      if (subscriptionPaymentMethod?.card) {
        return mapCardToPaymentMethod(subscriptionPaymentMethod.card);
      }
    }

    if (stripeCustomerId && stripe?.paymentMethods?.list) {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: "card",
        limit: 1,
      });

      const card = paymentMethods.data?.[0]?.card;

      if (card) {
        return mapCardToPaymentMethod(card);
      }
    }

    return getDefaultPaymentMethod();
  } catch (error) {
    return getDefaultPaymentMethod();
  }
};

const getNextChargeDetails = async (stripe, stripeCustomerId) => {
  if (!stripeCustomerId || !stripe?.invoices?.retrieveUpcoming) {
    return getDefaultNextCharge();
  }

  try {
    const upcomingInvoice = await stripe.invoices.retrieveUpcoming({
      customer: stripeCustomerId,
    });

    return {
      amount: upcomingInvoice.amount_due || 0,
      currency: upcomingInvoice.currency || "usd",
      display: formatStripeMoney(
        upcomingInvoice.amount_due || 0,
        upcomingInvoice.currency || "usd",
      ),
      nextPaymentAttempt: toDateFromUnix(upcomingInvoice.next_payment_attempt),
    };
  } catch (error) {
    return getDefaultNextCharge();
  }
};

const mapStripeInvoice = (invoice) => ({
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

const isAccessStatus = (status) => {
  return ["trialing", "active"].includes(status);
};

const expireTrialIfNeeded = async (business, subscription) => {
  if (!business || !subscription) return subscription;

  const now = new Date();

  const trialExpired =
    subscription.status === "trialing" &&
    subscription.trialEndsAt &&
    subscription.trialEndsAt <= now;

  if (!trialExpired) {
    return subscription;
  }

  subscription.status = "expired";
  subscription.lastPaymentStatus = "trial_expired";
  subscription.isActive = false;
  subscription.aiEnabled = false;
  await subscription.save();

  business.isActive = false;
  await business.save();

  return subscription;
};

class BillingController {
  static async startFreeTrial(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(
          res,
          "Business not found. Create a business before starting a free trial.",
        );
      }

      let subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      if (subscription) {
        subscription = await expireTrialIfNeeded(business, subscription);
      }

      const now = new Date();

      const hasActiveTrial =
        subscription?.status === "trialing" &&
        subscription?.trialEndsAt &&
        subscription.trialEndsAt > now;

      const hasActiveSubscription = subscription?.status === "active";

      if (hasActiveTrial || hasActiveSubscription) {
        return Response.responseInvalidInput(
          res,
          "This business already has active access.",
        );
      }

      const trialEndsAt = addDays(now, 14);

      subscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        business._id,
        {
          plan: "pro",
          status: "trialing",
          lastPaymentStatus: "trialing",
          trialStartedAt: now,
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd: trialEndsAt,
          cancelAtPeriodEnd: false,
          priceMonthly: 199,
          aiEnabled: true,
          isActive: true,
        },
      );

      business.isActive = true;
      await business.save();

      return Response.responseOk(
        res,
        {
          business,
          subscription,
        },
        "14-day free trial started successfully",
      );
    } catch (error) {
      console.error("Error in startFreeTrial:", error);
      return Response.responseServerError(res);
    }
  }

  static async createCheckoutSession(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await checkoutSchema.validateAsync(req.body);

      const { plan } = req.body;

      const priceId = getPriceIdByPlan(plan);

      if (!priceId) {
        return Response.responseInvalidInput(
          res,
          "Stripe price ID is not configured for this plan",
        );
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const stripe = getStripeClient();

      let subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      let stripeCustomerId = subscription?.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          name: business.businessName,
          email: business.email || undefined,
          metadata: {
            ownerId: String(ownerId),
            businessId: String(business._id),
          },
        });

        stripeCustomerId = customer.id;
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: `${getClientUrl()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${getClientUrl()}/billing/cancel`,
        metadata: {
          ownerId: String(ownerId),
          businessId: String(business._id),
          plan,
        },
        subscription_data: {
          metadata: {
            ownerId: String(ownerId),
            businessId: String(business._id),
            plan,
          },
        },
        saved_payment_method_options: {
          payment_method_save: "enabled",
        },
      });

      const currentlyTrialing =
        subscription?.status === "trialing" &&
        subscription?.trialEndsAt &&
        subscription.trialEndsAt > new Date();

      subscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        business._id,
        {
          stripeCustomerId,
          checkoutSessionId: session.id,
          plan,
          status: currentlyTrialing ? "trialing" : "incomplete",
          lastPaymentStatus: currentlyTrialing
            ? "trialing"
            : "checkout_started",
          isActive: currentlyTrialing,
          aiEnabled: currentlyTrialing
            ? true
            : (subscription?.aiEnabled ?? true),
        },
      );

      return Response.responseOk(
        res,
        {
          checkoutUrl: session.url,
          checkoutSessionId: session.id,
          subscription,
        },
        "Checkout session created successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createCheckoutSession:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMySubscription(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      let subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      if (subscription) {
        subscription = await expireTrialIfNeeded(business, subscription);
      }

      const baseSubscription = subscription || {
        business: business._id,
        plan: "pro",
        status: "none",
        stripeCustomerId: "",
        stripeSubscriptionId: "",
        cancelAtPeriodEnd: false,
        trialStartedAt: null,
        trialEndsAt: null,
        isActive: false,
        aiEnabled: true,
        priceMonthly: 199,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        latestInvoiceId: "",
        lastPaymentStatus: "",
      };

      let billingDetails = {
        paymentMethod: getDefaultPaymentMethod(),
        nextCharge: getDefaultNextCharge(),
        invoices: [],
      };

      if (baseSubscription.stripeCustomerId) {
        const stripe = getStripeClient();

        const [paymentMethod, nextCharge] = await Promise.all([
          getPaymentMethodSummary(
            stripe,
            baseSubscription.stripeCustomerId,
            baseSubscription.stripeSubscriptionId,
          ),
          getNextChargeDetails(stripe, baseSubscription.stripeCustomerId),
        ]);

        let invoiceList = { data: [] };

        if (stripe?.invoices?.list) {
          invoiceList = await stripe.invoices.list({
            customer: baseSubscription.stripeCustomerId,
            limit: 10,
          });
        }

        billingDetails = {
          paymentMethod,
          nextCharge,
          invoices: Array.isArray(invoiceList.data)
            ? invoiceList.data.map(mapStripeInvoice)
            : [],
        };
      }

      return Response.responseOk(
        res,
        {
          ...(baseSubscription.toObject?.() ?? baseSubscription),
          billingDetails,
        },
        "Subscription fetched successfully",
      );
    } catch (error) {
      console.error("Error in getMySubscription:", error);
      return Response.responseServerError(res);
    }
  }

  static async getBillingHistory(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      if (!subscription?.stripeCustomerId) {
        return Response.responseOk(res, [], "No billing history found");
      }

      const stripe = getStripeClient();

      if (!stripe?.invoices?.list) {
        return Response.responseOk(res, [], "No billing history found");
      }

      const invoices = await stripe.invoices.list({
        customer: subscription.stripeCustomerId,
        limit: 24,
      });

      return Response.responseOk(
        res,
        Array.isArray(invoices.data) ? invoices.data.map(mapStripeInvoice) : [],
        "Billing history fetched successfully",
      );
    } catch (error) {
      console.error("Error in getBillingHistory:", error);
      return Response.responseServerError(res);
    }
  }

  static async createBillingPortalSession(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      if (!subscription?.stripeCustomerId) {
        return Response.responseInvalidInput(
          res,
          "Stripe customer not found. Start checkout before managing billing.",
        );
      }

      const stripe = getStripeClient();

      if (!stripe?.billingPortal?.sessions?.create) {
        return Response.responseInvalidInput(
          res,
          "Stripe billing portal is not configured.",
        );
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: subscription.stripeCustomerId,
        return_url: `${getClientUrl()}/billing`,
      });

      return Response.responseOk(
        res,
        {
          portalUrl: portalSession.url,
        },
        "Billing portal session created successfully",
      );
    } catch (error) {
      console.error("Error in createBillingPortalSession:", error);
      return Response.responseServerError(res);
    }
  }

  static async cancelSubscription(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      if (!subscription || !subscription.stripeSubscriptionId) {
        return Response.responseInvalidInput(
          res,
          "Active Stripe subscription not found",
        );
      }

      const stripe = getStripeClient();

      const canceledSubscription = await stripe.subscriptions.update(
        subscription.stripeSubscriptionId,
        {
          cancel_at_period_end: true,
        },
      );

      const updatedSubscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        business._id,
        {
          cancelAtPeriodEnd: true,
          status: canceledSubscription.status || subscription.status,
          lastPaymentStatus:
            canceledSubscription.status || subscription.lastPaymentStatus,
          currentPeriodStart: toDateFromUnix(
            canceledSubscription.current_period_start,
          ),
          currentPeriodEnd: toDateFromUnix(
            canceledSubscription.current_period_end,
          ),
        },
      );

      return Response.responseOk(
        res,
        updatedSubscription,
        "Subscription cancellation scheduled",
      );
    } catch (error) {
      console.error("Error in cancelSubscription:", error);
      return Response.responseServerError(res);
    }
  }

  static async handleStripeWebhook(req, res) {
    try {
      const stripe = getStripeClient();

      let event;
      const signature = req.headers["stripe-signature"];

      if (process.env.STRIPE_WEBHOOK_SECRET && signature) {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } else {
        if (Buffer.isBuffer(req.body)) {
          event = JSON.parse(req.body.toString("utf8"));
        } else {
          event = req.body;
        }
      }

      switch (event.type) {
        case "checkout.session.completed":
          await BillingController.handleCheckoutCompleted(event.data.object);
          break;

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          await BillingController.handleSubscriptionUpdated(event.data.object);
          break;

        case "invoice.paid":
          await BillingController.handleInvoicePaid(event.data.object);
          break;

        case "invoice.payment_failed":
          await BillingController.handleInvoicePaymentFailed(event.data.object);
          break;

        default:
          break;
      }

      return res.status(200).json({
        success: true,
        received: true,
      });
    } catch (error) {
      console.error("Stripe webhook error:", error.message);

      return res.status(400).json({
        success: false,
        message: `Webhook Error: ${error.message}`,
      });
    }
  }

  static async handleCheckoutCompleted(session) {
    const businessId = session.metadata?.businessId;
    const plan = session.metadata?.plan || "pro";

    if (!businessId) return null;

    let stripeCustomerId = session.customer || "";
    let stripeSubscriptionId = session.subscription || "";
    let stripeStatus = "active";
    let currentPeriodStart = null;
    let currentPeriodEnd = null;
    let trialStartedAt = null;
    let trialEndsAt = null;
    let latestInvoiceId = "";

    if (stripeSubscriptionId) {
      const stripe = getStripeClient();
      const stripeSubscription = await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
        {
          expand: ["latest_invoice"],
        },
      );

      stripeStatus = stripeSubscription.status || "active";
      stripeCustomerId = stripeSubscription.customer || stripeCustomerId;
      currentPeriodStart = toDateFromUnix(
        stripeSubscription.current_period_start,
      );
      currentPeriodEnd = toDateFromUnix(stripeSubscription.current_period_end);
      trialStartedAt = toDateFromUnix(stripeSubscription.trial_start);
      trialEndsAt = toDateFromUnix(stripeSubscription.trial_end);

      if (typeof stripeSubscription.latest_invoice === "string") {
        latestInvoiceId = stripeSubscription.latest_invoice;
      } else {
        latestInvoiceId = stripeSubscription.latest_invoice?.id || "";
      }
    }

    const isActive = isAccessStatus(stripeStatus);

    const subscription = await Db.upsertSubscriptionByBusiness(
      Subscription,
      businessId,
      {
        stripeCustomerId,
        stripeSubscriptionId,
        checkoutSessionId: session.id || "",
        latestInvoiceId,
        plan,
        status: stripeStatus,
        lastPaymentStatus: stripeStatus,
        currentPeriodStart,
        currentPeriodEnd,
        trialStartedAt,
        trialEndsAt,
        isActive,
        aiEnabled: isActive,
      },
    );

    await Business.findByIdAndUpdate(businessId, { isActive });

    return subscription;
  }

  static async handleSubscriptionUpdated(stripeSubscription) {
    const stripe = getStripeClient();

    if (stripeSubscription?.id && stripe?.subscriptions?.retrieve) {
      stripeSubscription = await stripe.subscriptions.retrieve(
        stripeSubscription.id,
        {
          expand: ["latest_invoice"],
        },
      );
    }

    const businessId = stripeSubscription.metadata?.businessId;

    const priceId =
      stripeSubscription.items?.data?.[0]?.price?.id ||
      stripeSubscription.plan?.id ||
      "";

    const stripeStatus = stripeSubscription.status || "none";
    const isActive = isAccessStatus(stripeStatus);

    let latestInvoiceId = "";

    if (typeof stripeSubscription.latest_invoice === "string") {
      latestInvoiceId = stripeSubscription.latest_invoice;
    } else {
      latestInvoiceId = stripeSubscription.latest_invoice?.id || "";
    }

    const data = {
      stripeCustomerId: stripeSubscription.customer || "",
      stripeSubscriptionId: stripeSubscription.id || "",
      latestInvoiceId,
      plan: stripeSubscription.metadata?.plan || inferPlanFromPriceId(priceId),
      status: stripeStatus,
      lastPaymentStatus: stripeStatus,
      currentPeriodStart: toDateFromUnix(
        stripeSubscription.current_period_start,
      ),
      currentPeriodEnd: toDateFromUnix(stripeSubscription.current_period_end),
      trialStartedAt: toDateFromUnix(stripeSubscription.trial_start),
      trialEndsAt: toDateFromUnix(stripeSubscription.trial_end),
      cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end),
      isActive,
      aiEnabled: isActive,
    };

    if (businessId) {
      const subscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        businessId,
        data,
      );

      await Business.findByIdAndUpdate(businessId, { isActive });

      return subscription;
    }

    if (stripeSubscription.id) {
      return await Db.updateSubscriptionByStripeSubscription(
        Subscription,
        stripeSubscription.id,
        data,
      );
    }

    return null;
  }

  static async handleInvoicePaid(invoice) {
    if (!invoice.subscription) return null;

    return await Db.updateSubscriptionByStripeSubscription(
      Subscription,
      invoice.subscription,
      {
        latestInvoiceId: invoice.id || "",
        lastPaymentStatus: "paid",
        status: "active",
        isActive: true,
        aiEnabled: true,
        currentPeriodStart: toDateFromUnix(invoice.period_start),
        currentPeriodEnd: toDateFromUnix(invoice.period_end),
      },
    );
  }

  static async handleInvoicePaymentFailed(invoice) {
    if (!invoice.subscription) return null;

    return await Db.updateSubscriptionByStripeSubscription(
      Subscription,
      invoice.subscription,
      {
        latestInvoiceId: invoice.id || "",
        lastPaymentStatus: "failed",
        status: "past_due",
        isActive: false,
        aiEnabled: false,
        currentPeriodStart: toDateFromUnix(invoice.period_start),
        currentPeriodEnd: toDateFromUnix(invoice.period_end),
      },
    );
  }

  static async updateAdminCustomerAccountStatus(req, res) {
    try {
      const role = String(req.user?.role || "").toLowerCase();

      if (role !== "admin") {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { businessId } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== "boolean") {
        return Response.responseInvalidInput(
          res,
          "isActive must be true or false",
        );
      }

      const business = await Business.findByIdAndUpdate(
        businessId,
        { isActive },
        { new: true },
      );

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const existingSubscription = await Subscription.findOne({
        business: business._id,
      });

      const nextStatus = isActive
        ? isAccessStatus(existingSubscription?.status)
          ? existingSubscription.status
          : "active"
        : "canceled";

      await Subscription.findOneAndUpdate(
        { business: business._id },
        {
          isActive,
          aiEnabled: isActive,
          status: nextStatus,
          lastPaymentStatus: isActive ? nextStatus : "admin_deactivated",
        },
        { new: true },
      );

      return Response.responseOk(
        res,
        business,
        isActive
          ? "Customer account activated successfully"
          : "Customer account deactivated successfully",
      );
    } catch (error) {
      console.error("Error in updateAdminCustomerAccountStatus:", error);
      return Response.responseServerError(res);
    }
  }
}

export default BillingController;
