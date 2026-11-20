import {completeObservedSubscription} from '../../services/subscriptionState.service.js';
import "../../models/trialRedemption.js";
import * as Response from "../../helpers/response/response.js";
import { createTrialPaymentMethodCheckout, resumeCanonicalSubscription } from "../../services/subscriptionActions.service.js";
import { getRequestBusiness, getRequestSubscription } from "./helpers.js";
import { getStripeClient } from "../../helpers/stripe/stripeClient.js";
import { safeConsole } from "../../helpers/logging/safeLogger.js";
import { stripePeriodDates } from "../../helpers/billing/stripeSubscriptionSnapshot.js";

export default class BillingSubscriptionActionsController {
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

      const completion=await completeObservedSubscription({businessId:business._id,observed:subscription,fields:{
        cancelAtPeriodEnd:true,status:canceledSubscription.status || subscription.status,
        lastPaymentStatus:canceledSubscription.status || subscription.lastPaymentStatus,
        ...stripePeriodDates(canceledSubscription,subscription),
      }});
      if (!completion.applied) return res.status(409).json({success:false,code:'SUBSCRIPTION_STATE_CHANGED',
        message:'Subscription changed while cancellation was being scheduled. Reload Billing.'});
      const updatedSubscription=completion.current;

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
}
