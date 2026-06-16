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

const inferPlanFromPriceId = (priceId) => {
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID) return "starter";
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return "pro";
  if (priceId === process.env.STRIPE_AGENCY_PRICE_ID) return "agency";
  return "starter";
};

class BillingController {
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
      });

      subscription = await Db.upsertSubscriptionByBusiness(
        Subscription,
        business._id,
        {
          stripeCustomerId,
          checkoutSessionId: session.id,
          plan,
          status: "incomplete",
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

      const subscription = await Db.getSubscriptionByBusiness(
        Subscription,
        business._id,
      );

      return Response.responseOk(
        res,
        subscription || {
          business: business._id,
          plan: "starter",
          status: "none",
          stripeCustomerId: "",
          stripeSubscriptionId: "",
          cancelAtPeriodEnd: false,
          currentPeriodStart: null,
          currentPeriodEnd: null,
        },
        "Subscription fetched successfully",
      );
    } catch (error) {
      console.error("Error in getMySubscription:", error);
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

      console.log("Stripe webhook event type:", event.type);
      console.log("Stripe webhook event object:", event.data?.object);

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
    const plan = session.metadata?.plan || "starter";

    if (!businessId) return null;

    return await Db.upsertSubscriptionByBusiness(Subscription, businessId, {
      stripeCustomerId: session.customer || "",
      stripeSubscriptionId: session.subscription || "",
      checkoutSessionId: session.id || "",
      plan,
      status: "active",
    });
  }

  static async handleSubscriptionUpdated(stripeSubscription) {
    const businessId = stripeSubscription.metadata?.businessId;

    const priceId =
      stripeSubscription.items?.data?.[0]?.price?.id ||
      stripeSubscription.plan?.id ||
      "";

    const data = {
      stripeCustomerId: stripeSubscription.customer || "",
      stripeSubscriptionId: stripeSubscription.id || "",
      plan: stripeSubscription.metadata?.plan || inferPlanFromPriceId(priceId),
      status: stripeSubscription.status || "none",
      currentPeriodStart: toDateFromUnix(
        stripeSubscription.current_period_start,
      ),
      currentPeriodEnd: toDateFromUnix(stripeSubscription.current_period_end),
      cancelAtPeriodEnd: Boolean(stripeSubscription.cancel_at_period_end),
    };

    if (businessId) {
      return await Db.upsertSubscriptionByBusiness(
        Subscription,
        businessId,
        data,
      );
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
      },
    );
  }
}

export default BillingController;
