import { Response, TRIAL_PRICE_MONTHLY, assertCanonicalIsOnlyLiveSubscription, expireTrialIfNeeded, getClientUrl, getDefaultNextCharge, getDefaultPaymentMethod, getNextChargeDetails, getPaymentMethodSummary, getRequestBusiness, getRequestSubscription, getStripeClient, getSubscriptionAccess, getTrialEligibility, isAccessStatus, mapStripeInvoice, safeConsole } from './context.js';

export default class BillingReadsController {
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
}
