import Db from "../db/db.js";
import Business from "../models/business.js";
import Subscription from "../models/subscription.js";
import TrialRedemption from "../models/trialRedemption.js";
import { checkoutSchema } from "../validator/billing.js";
import {
  getStripeClient,
  getPriceIdByPlan,
} from "../helpers/stripe/stripeClient.js";
import * as Response from "../helpers/response/response.js";
import {
  createSubscriptionCheckout,
  extendTrialByAdmin,
  sendTrialLifecycleMessage,
  syncCheckoutSession,
  syncStripeSubscription,
} from "../services/trialLifecycle.service.js";
import { getTrialEligibility } from "../helpers/billing/trial.js";
import { processStripeEventOnce } from "../services/billingEvent.service.js";
import {
  createTrialPaymentMethodCheckout,
  completeTrialPaymentMethodCheckout,
  resumeCanonicalSubscription,
} from "../services/subscriptionActions.service.js";
import {
  assertCanonicalIsOnlyLiveSubscription,
  guardInvoiceAgainstCanonicalSubscription,
} from "../services/subscriptionIntegrity.service.js";
import {
  ACCESS_LEVELS,
  getSubscriptionAccess,
} from "../services/subscriptionAccess.service.js";
import {
  assertTrialIdentityVerified,
  securityGateEnabled,
} from "../services/trialIdentityVerification.service.js";
import { enforceTrialActivationRisk } from "../services/trialRisk.service.js";
import { verifyTurnstileToken } from "../helpers/security/turnstile.js";

const TRIAL_DAYS = 14;

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

const normalizeEmail = (email = "") => {
  return String(email || "")
    .trim()
    .toLowerCase();
};

const normalizePhone = (phone = "") => {
  const digits = String(phone || "").replace(/\D/g, "");

  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return `+${digits}`;
};

const buildTrialIdentity = (business, ownerId) => {
  const emailKey =
    normalizeEmail(business?.email) || normalizeEmail(business?.owner?.email);

  const phoneKey = normalizePhone(
    business?.forwardingPhone || business?.businessPhone || business?.phone,
  );

  return {
    ownerId,
    emailKey,
    phoneKey,
  };
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

const getSubscriptionPeriodDates = (stripeSubscription) => {
  const item = stripeSubscription?.items?.data?.[0];

  return {
    currentPeriodStart: toDateFromUnix(
      stripeSubscription?.current_period_start || item?.current_period_start,
    ),
    currentPeriodEnd: toDateFromUnix(
      stripeSubscription?.current_period_end || item?.current_period_end,
    ),
  };
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

const getNextChargeDetails = async (
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

/*
 * Keep subscription entitlement separate from Business.isActive.
 * A trial expiring removes product access, but it must not suspend the
 * business account itself or erase lifetime trial-consumption fields.
 */
const expireTrialIfNeeded = async (subscription) => {
  if (!subscription) return subscription;

  const trialEndsAt = subscription.trialEndsAt
    ? new Date(subscription.trialEndsAt)
    : null;

  const expired =
    subscription.status === "trialing" &&
    trialEndsAt &&
    trialEndsAt <= new Date();

  if (!expired) {
    return subscription;
  }

  return Subscription.findByIdAndUpdate(
    subscription._id,
    {
      $set: {
        status: "expired",
        lastPaymentStatus: "trial_expired",
        isActive: false,
        aiEnabled: false,
      },
    },
    {
      returnDocument: "after",
      runValidators: true,
    },
  );
};

const getRequestBusiness = async (req, ownerId) => {
  if (req.business) {
    return req.business;
  }

  const business = await Db.getBusinessByOwner(Business, ownerId);

  if (business) {
    req.business = business;
  }

  return business;
};

const getRequestSubscription = async (req, businessId) => {
  if (
    req.subscription &&
    String(req.subscription.business?._id || req.subscription.business) ===
      String(businessId)
  ) {
    return req.subscription;
  }

  /*
   * Query the model directly so this controller remains compatible with both
   * the original and optimized Db helper versions. A full Mongoose document
   * is required because trial-expiration logic may update the subscription.
   */
  const subscription = await Subscription.findOne({
    business: businessId,
  });

  if (subscription) {
    req.subscription = subscription;
  }

  return subscription;
};

class BillingController {
  static async startFreeTrial(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getRequestBusiness(req, ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      await assertTrialIdentityVerified({ ownerId, business });

      if (securityGateEnabled("TRIAL_TURNSTILE_REQUIRED")) {
        const challenge = await verifyTurnstileToken(
          req.body?.securityChallengeToken || "",
          req,
          { expectedAction: "trial_activation" },
        );
        if (!challenge.success) {
          return res.status(403).json({
            success: false,
            code: "TRIAL_SECURITY_CHALLENGE_REQUIRED",
            message: "Complete the security check before activating the free trial.",
          });
        }
      }

      await enforceTrialActivationRisk({ business });

      const result = await createSubscriptionCheckout({
        business,
        ownerId,
        plan: "pro",
        requireTrial: true,
        returnToSetup: req.body?.onboarding === true,
      });

      return Response.responseOk(
        res,
        result,
        "Stripe trial checkout session created successfully",
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
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
      const business = await getRequestBusiness(req, ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const result = await createSubscriptionCheckout({
        business,
        ownerId,
        plan,
        requireTrial: false,
      });

      return Response.responseOk(
        res,
        result,
        result.trialOffered
          ? "14-day Stripe trial checkout session created successfully"
          : "Paid Stripe checkout session created successfully",
      );
    } catch (error) {
      if (error?.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      console.error("Error in createCheckoutSession:", error);
      return Response.responseServerError(res);
    }
  }

  static async confirmCheckoutSession(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const sessionId = String(
        req.body?.sessionId || req.body?.session_id || "",
      ).trim();

      if (!sessionId.startsWith("cs_") || sessionId.length > 255) {
        return res.status(400).json({
          success: false,
          code: "INVALID_CHECKOUT_SESSION",
          message: "A valid Stripe Checkout session ID is required.",
        });
      }

      const business = await getRequestBusiness(req, ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const localSubscription = await getRequestSubscription(req, business._id);
      const localSessionId = String(
        localSubscription?.checkoutSessionId || "",
      ).trim();

      // Only reconcile the exact session this business previously created.
      // Stripe metadata is verified below as a second ownership boundary.
      if (!localSessionId || localSessionId !== sessionId) {
        return res.status(403).json({
          success: false,
          code: "CHECKOUT_SESSION_MISMATCH",
          message: "This Checkout session does not belong to the current account.",
        });
      }

      const stripe = getStripeClient();
      if (!stripe?.checkout?.sessions?.retrieve) {
        return res.status(503).json({
          success: false,
          code: "STRIPE_NOT_CONFIGURED",
          message: "Stripe checkout confirmation is not configured.",
        });
      }

      let checkoutSession = null;
      try {
        checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
      } catch (error) {
        if (error?.code === "resource_missing" || error?.statusCode === 404) {
          return res.status(404).json({
            success: false,
            code: "CHECKOUT_SESSION_NOT_FOUND",
            message: "Stripe Checkout session was not found.",
          });
        }
        throw error;
      }

      const checkoutBusinessId = String(
        checkoutSession?.metadata?.businessId || "",
      );
      const checkoutOwnerId = String(
        checkoutSession?.metadata?.ownerId || "",
      );
      const checkoutCustomerId = String(
        typeof checkoutSession?.customer === "string"
          ? checkoutSession.customer
          : checkoutSession?.customer?.id || "",
      );
      const localCustomerId = String(
        localSubscription?.stripeCustomerId || "",
      );
      const ownershipMatches =
        checkoutBusinessId === String(business._id) &&
        checkoutOwnerId === String(ownerId) &&
        (!localCustomerId || checkoutCustomerId === localCustomerId);

      if (!ownershipMatches) {
        return res.status(403).json({
          success: false,
          code: "CHECKOUT_SESSION_OWNERSHIP_MISMATCH",
          message: "This Checkout session does not belong to the current account.",
        });
      }

      if (checkoutSession?.mode !== "subscription") {
        return res.status(400).json({
          success: false,
          code: "CHECKOUT_MODE_INVALID",
          message: "This Checkout session is not a subscription checkout.",
        });
      }

      if (checkoutSession?.status !== "complete") {
        return res.status(409).json({
          success: false,
          code: "CHECKOUT_NOT_COMPLETE",
          message: "Stripe Checkout has not completed yet.",
        });
      }

      if (!checkoutSession?.subscription) {
        return res.status(409).json({
          success: false,
          code: "CHECKOUT_SUBSCRIPTION_MISSING",
          message: "Stripe has not attached a subscription to this Checkout session yet.",
        });
      }

      // If the webhook won the race, do not repeat lifecycle side effects.
      const freshLocalSubscription = await Subscription.findOne({
        business: business._id,
      });
      const currentAccess = getSubscriptionAccess(freshLocalSubscription);
      let subscription = freshLocalSubscription;

      if (currentAccess.level !== ACCESS_LEVELS.FULL) {
        subscription = await syncCheckoutSession(checkoutSession);
      }

      if (!subscription) {
        return res.status(409).json({
          success: false,
          code: "CHECKOUT_RECONCILIATION_PENDING",
          message: "Checkout completed, but subscription reconciliation is still pending.",
        });
      }

      const access = getSubscriptionAccess(subscription);
      req.subscription = subscription;

      return Response.responseOk(
        res,
        {
          checkoutSessionId: sessionId,
          status: access.status,
          accessLevel: access.level,
          reason: access.reason,
          subscription: subscription.toObject?.() ?? subscription,
        },
        "Stripe Checkout session confirmed successfully",
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code || "CHECKOUT_CONFIRMATION_FAILED",
          message: error.message,
        });
      }

      console.error("Error in confirmCheckoutSession:", error);
      return res.status(500).json({
        success: false,
        code: "CHECKOUT_CONFIRMATION_FAILED",
        message: "Unable to confirm Stripe Checkout right now.",
      });
    }
  }
  static async createTrialPaymentMethodSession(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) return Response.responseBadAuth(res, "Not authenticated");
      const business = await getRequestBusiness(req, ownerId);
      if (!business) return Response.responseInvalidInput(res, "Business not found");
      const result = await createTrialPaymentMethodCheckout({ business, ownerId });
      return Response.responseOk(
        res,
        result,
        "Trial payment-method checkout session created successfully",
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      console.error("Error in createTrialPaymentMethodSession:", error);
      return Response.responseServerError(res);
    }
  }

  static async resumeSubscription(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) return Response.responseBadAuth(res, "Not authenticated");
      const business = await getRequestBusiness(req, ownerId);
      if (!business) return Response.responseInvalidInput(res, "Business not found");
      const subscription = await resumeCanonicalSubscription({ businessId: business._id });
      return Response.responseOk(res, subscription, "Subscription resumed successfully");
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      console.error("Error in resumeSubscription:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMySubscriptionAccess(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getRequestBusiness(req, ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      let subscription = await getRequestSubscription(req, business._id);
      if (subscription) {
        subscription = await expireTrialIfNeeded(subscription);
      }

      const access = getSubscriptionAccess(subscription);

      return Response.responseOk(
        res,
        {
          status: access.status,
          accessLevel: access.level,
          reason: access.reason,
          automationAllowed: access.automationAllowed,
          providerActionsAllowed: access.providerActionsAllowed,
          checkoutSessionId: subscription?.checkoutSessionId || "",
          lastPaymentStatus: subscription?.lastPaymentStatus || "",
          isActive: subscription?.isActive ?? false,
          cancelAtPeriodEnd: Boolean(subscription?.cancelAtPeriodEnd),
          currentPeriodEnd: subscription?.currentPeriodEnd || null,
          trialEndsAt: subscription?.trialEndsAt || null,
        },
        "Subscription access fetched successfully",
      );
    } catch (error) {
      console.error("Error in getMySubscriptionAccess:", error);
      return Response.responseServerError(res);
    }
  }
  static async getMySubscription(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getRequestBusiness(req, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      let subscription = await getRequestSubscription(req, business._id);

      if (subscription) {
        subscription = await expireTrialIfNeeded(subscription);
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
        trialUsedAt: null,
        trialCount: 0,
        trialOverrideGrantedAt: null,
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

        const [paymentMethod, nextCharge, invoiceList] = await Promise.all([
          getPaymentMethodSummary(
            stripe,
            baseSubscription.stripeCustomerId,
            baseSubscription.stripeSubscriptionId,
          ),
          getNextChargeDetails(
            stripe,
            baseSubscription.stripeCustomerId,
            baseSubscription.stripeSubscriptionId,
          ),
          stripe?.invoices?.list
            ? stripe.invoices.list({
                customer: baseSubscription.stripeCustomerId,
                limit: 10,
              })
            : Promise.resolve({ data: [] }),
        ]);

        billingDetails = {
          paymentMethod,
          nextCharge,
          invoices: Array.isArray(invoiceList?.data)
            ? invoiceList.data.map(mapStripeInvoice)
            : [],
        };
      }

      const hasActiveAccess = isAccessStatus(baseSubscription.status);
      const trialEligibility = await getTrialEligibility({
        business,
        ownerId,
        subscription,
      });

      return Response.responseOk(
        res,
        {
          ...(baseSubscription.toObject?.() ?? baseSubscription),
          billingDetails,
          canStartTrial: !hasActiveAccess && trialEligibility.eligible,
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

      const business = await getRequestBusiness(req, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const subscription = await getRequestSubscription(req, business._id);

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

      const business = await getRequestBusiness(req, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const subscription = await getRequestSubscription(req, business._id);

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
      if (subscription.stripeSubscriptionId) {
        await assertCanonicalIsOnlyLiveSubscription({
          stripe,
          subscription,
          source: "billing_portal",
        });
      }

      const portalConfigurationId = String(
        process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || "",
      ).trim();
      if (!portalConfigurationId) {
        return res.status(503).json({
          success: false,
          code: "STRIPE_PORTAL_CONFIGURATION_REQUIRED",
          message: "Restricted Stripe billing portal configuration is not configured.",
        });
      }
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: subscription.stripeCustomerId,
        return_url: `${getClientUrl()}/billing`,
        configuration: portalConfigurationId,
      });

      return Response.responseOk(
        res,
        {
          portalUrl: portalSession.url,
        },
        "Billing portal session created successfully",
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
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

      const business = await getRequestBusiness(req, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const subscription = await getRequestSubscription(req, business._id);

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
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
    if (!webhookSecret) {
      console.error("Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not configured");
      return res.status(503).json({
        success: false,
        message: "Stripe webhook verification is not configured",
      });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({
        success: false,
        message: "Stripe signature is required",
      });
    }

    try {
      const stripe = getStripeClient();
      const event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        webhookSecret,
      );
      const handlers = {
        "checkout.session.completed": (object) => BillingController.handleCheckoutCompleted(object),
        "customer.subscription.created": (object) => BillingController.handleSubscriptionUpdated(object),
        "customer.subscription.updated": (object) => BillingController.handleSubscriptionUpdated(object),
        "customer.subscription.deleted": (object) => BillingController.handleSubscriptionUpdated(object),
        "customer.subscription.paused": (object) => BillingController.handleSubscriptionUpdated(object),
        "customer.subscription.resumed": (object) => BillingController.handleSubscriptionUpdated(object),
        "customer.subscription.trial_will_end": async (object) => {
          const subscription = await BillingController.handleSubscriptionUpdated(object);
          await sendTrialLifecycleMessage(subscription, "three_day");
          return subscription;
        },
        "invoice.paid": (object) => BillingController.handleInvoicePaid(object, event.id || ""),
        "invoice.payment_failed": (object) => BillingController.handleInvoicePaymentFailed(object, event.id || ""),
      };

      const processingResult = event.id
        ? await processStripeEventOnce({
            event,
            requestId:
              req.id ||
              req.headers["x-request-id"] ||
              req.headers["x-correlation-id"] ||
              "",
            handlers,
          })
        : {
            duplicate: false,
            handled: Boolean(handlers[event.type]),
            result: handlers[event.type]
              ? await handlers[event.type](event.data.object)
              : null,
          };

      return res.status(200).json({
        success: true,
        received: true,
        duplicate: Boolean(processingResult?.duplicate),
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
    if (
      session?.mode === "setup" &&
      session?.metadata?.purpose === "trial_payment_method"
    ) {
      return completeTrialPaymentMethodCheckout({ checkoutSession: session });
    }
    return syncCheckoutSession(session);
  }

  static async handleSubscriptionUpdated(stripeSubscription) {
    return syncStripeSubscription({ stripeSubscription });
  }

  static async handleInvoicePaid(invoice, eventId = "") {
    if (!invoice.subscription) return null;

    const invoiceGuard = await guardInvoiceAgainstCanonicalSubscription({
      invoice,
      eventId,
      source: "invoice.paid",
    });
    if (!invoiceGuard.allowed) return invoiceGuard.subscription || null;

    const stripe = getStripeClient();
    const stripeSubscription = await stripe.subscriptions.retrieve(
      invoice.subscription,
      { expand: ["latest_invoice"] },
    );
    const subscription = await syncStripeSubscription({
      stripeSubscription,
      refreshFromStripe: false,
    });
    if (!subscription) return null;

    return Subscription.findByIdAndUpdate(
      subscription._id,
      {
        $set: {
          latestInvoiceId: invoice.id || subscription.latestInvoiceId || "",
          lastPaymentStatus: "paid",
        },
      },
      { returnDocument: "after", runValidators: true },
    );
  }

  static async handleInvoicePaymentFailed(invoice, eventId = "") {
    if (!invoice.subscription) return null;

    const invoiceGuard = await guardInvoiceAgainstCanonicalSubscription({
      invoice,
      eventId,
      source: "invoice.payment_failed",
    });
    if (!invoiceGuard.allowed) return invoiceGuard.subscription || null;

    const stripe = getStripeClient();
    const stripeSubscription = await stripe.subscriptions.retrieve(
      invoice.subscription,
      { expand: ["latest_invoice"] },
    );
    const subscription = await syncStripeSubscription({
      stripeSubscription,
      refreshFromStripe: false,
    });
    if (!subscription) return null;

    return Subscription.findByIdAndUpdate(
      subscription._id,
      {
        $set: {
          latestInvoiceId: invoice.id || subscription.latestInvoiceId || "",
          lastPaymentStatus: "failed",
        },
      },
      { returnDocument: "after", runValidators: true },
    );
  }

  static async adminGrantTrialOverride(req, res) {
    try {
      const { businessId } = req.params;
      const { days = 7, reason = "" } = req.body || {};
      const subscription = await extendTrialByAdmin({
        businessId,
        adminUserId: req.user.userId,
        days,
        reason,
      });

      return Response.responseOk(
        res,
        subscription,
        "Active trial extended without changing the lifetime trial identity lock",
      );
    } catch (error) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
        });
      }
      console.error("Error in adminGrantTrialOverride:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateAdminCustomerAccountStatus(req, res) {
    try {
      const { businessId } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== "boolean") {
        return Response.responseInvalidInput(
          res,
          "isActive must be true or false",
        );
      }

      const [business, existingSubscription] = await Promise.all([
        Business.findById(businessId),
        Subscription.findOne({ business: businessId }).select(
          "_id business status",
        ),
      ]);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const nextStatus = isActive
        ? isAccessStatus(existingSubscription?.status)
          ? existingSubscription.status
          : "active"
        : "canceled";

      const [updatedBusiness] = await Promise.all([
        Business.findByIdAndUpdate(
          businessId,
          { $set: { isActive } },
          {
            returnDocument: "after",
            runValidators: true,
          },
        ),
        Subscription.findOneAndUpdate(
          { business: businessId },
          {
            $set: {
              isActive,
              aiEnabled: isActive,
              status: nextStatus,
              lastPaymentStatus: isActive ? nextStatus : "admin_deactivated",
            },
          },
          {
            returnDocument: "after",
            runValidators: true,
          },
        ),
      ]);

      const responseBusiness = updatedBusiness || business;

      return Response.responseOk(
        res,
        responseBusiness,
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
