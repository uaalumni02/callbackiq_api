import {
  toDateFromUnix,
  getDefaultPaymentMethod,
  getDefaultNextCharge,
  getPaymentMethodSummary,
  getNextChargeDetails,
  mapStripeInvoice,
} from "../helpers/billing/stripeBillingDetails.js";
import { invoiceSubscriptionId } from "../helpers/billing/invoiceSubscriptionId.js";
import { safeConsole } from "../helpers/logging/safeLogger.js";
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
import {
  getTrialEligibility,
  TRIAL_PRICE_MONTHLY,
} from "../helpers/billing/trial.js";
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

const getClientUrl = () => {
  return process.env.CLIENT_URL || "http://localhost:3001";
};

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
      safeConsole.error("Error in startFreeTrial:", error);
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
      safeConsole.error("Error in createCheckoutSession:", error);
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

      safeConsole.error("Error in confirmCheckoutSession:", error);
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
      safeConsole.error("Error in createTrialPaymentMethodSession:", error);
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
      safeConsole.error("Error in resumeSubscription:", error);
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
      safeConsole.error("Error in getMySubscriptionAccess:", error);
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
        priceMonthly: TRIAL_PRICE_MONTHLY,
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
      safeConsole.error("Error in getMySubscription:", error);
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
      safeConsole.error("Error in getBillingHistory:", error);
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
      safeConsole.error("Error in createBillingPortalSession:", error);
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
      safeConsole.error("Error in cancelSubscription:", error);
      return Response.responseServerError(res);
    }
  }

  static async handleStripeWebhook(req, res) {
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
    if (!webhookSecret) {
      safeConsole.error("Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not configured");
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
      safeConsole.error("Stripe webhook error:", error.message);
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
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (!subscriptionId) return null;

    const invoiceGuard = await guardInvoiceAgainstCanonicalSubscription({
      invoice,
      eventId,
      source: "invoice.paid",
    });
    if (!invoiceGuard.allowed) return invoiceGuard.subscription || null;

    const stripe = getStripeClient();
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscriptionId,
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
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (!subscriptionId) return null;

    const invoiceGuard = await guardInvoiceAgainstCanonicalSubscription({
      invoice,
      eventId,
      source: "invoice.payment_failed",
    });
    if (!invoiceGuard.allowed) return invoiceGuard.subscription || null;

    const stripe = getStripeClient();
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscriptionId,
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
      safeConsole.error("Error in adminGrantTrialOverride:", error);
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
      safeConsole.error("Error in updateAdminCustomerAccountStatus:", error);
      return Response.responseServerError(res);
    }
  }
}

export default BillingController;
