import { Db, Response, Subscription, createTrialPaymentMethodCheckout, getRequestBusiness, getRequestSubscription, getStripeClient, resumeCanonicalSubscription, safeConsole, stripePeriodDates } from './context.js';

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

      const updatedSubscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        business._id,
        {
          cancelAtPeriodEnd: true,
          status: canceledSubscription.status || subscription.status,
          lastPaymentStatus:
            canceledSubscription.status || subscription.lastPaymentStatus,
          ...stripePeriodDates(canceledSubscription, subscription),
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
}
