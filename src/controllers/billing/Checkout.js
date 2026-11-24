import "../../models/trialRedemption.js";
import { ACCESS_LEVELS, getSubscriptionAccess } from "../../services/subscriptionAccess.service.js";
import * as Response from "../../helpers/response/response.js";
import Subscription from "../../models/subscription.js";
import { assertTrialIdentityVerified, securityGateEnabled } from "../../services/trialIdentityVerification.service.js";
import { checkoutSchema } from "../../validator/billing.js";
import { createSubscriptionCheckout, syncCheckoutSession } from "../../services/trialLifecycle.service.js";
import { enforceTrialActivationRisk } from "../../services/trialRisk.service.js";
import { getRequestBusiness, getRequestSubscription } from "./helpers.js";
import { getStripeClient } from "../../helpers/stripe/stripeClient.js";
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import { verifyTurnstileToken } from "../../helpers/security/turnstile.js";

export default class BillingCheckoutController {
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
        result.preparing ? result.message : "Stripe trial checkout session created successfully",
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
}
