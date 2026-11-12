import { completeTrialPaymentMethodCheckout, getStripeClient, guardInvoiceAgainstCanonicalSubscription, invoiceSubscriptionId, processStripeEventOnce, safeConsole, sendTrialLifecycleMessage, syncCheckoutSession, syncStripeSubscription } from './context.js';

export default class BillingWebhooksController {
static async handleStripeWebhook(req, res, dispatcher = BillingWebhooksController) {
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

    let signatureVerified = false;
    try {
      const stripe = getStripeClient();
      const event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        webhookSecret,
      );
      signatureVerified = true;
      const handlers = {
        "checkout.session.completed": (object) => dispatcher.handleCheckoutCompleted(object),
        "customer.subscription.created": (object) => dispatcher.handleSubscriptionUpdated(object),
        "customer.subscription.updated": (object) => dispatcher.handleSubscriptionUpdated(object),
        "customer.subscription.deleted": (object) => dispatcher.handleSubscriptionUpdated(object),
        "customer.subscription.paused": (object) => dispatcher.handleSubscriptionUpdated(object),
        "customer.subscription.resumed": (object) => dispatcher.handleSubscriptionUpdated(object),
        "customer.subscription.trial_will_end": async (object) => {
          const subscription = await dispatcher.handleSubscriptionUpdated(object);
          await sendTrialLifecycleMessage(subscription, "three_day");
          return subscription;
        },
        "invoice.paid": (object) => dispatcher.handleInvoicePaid(object, event.id || ""),
        "invoice.payment_failed": (object) => dispatcher.handleInvoicePaymentFailed(object, event.id || ""),
      };

      const processingResult = event.id
        ? await processStripeEventOnce({
            event,
            requestId:
              req.context?.requestId || req.id ||
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

      if (processingResult?.inProgress) {
        res.set?.('Retry-After', '10');
        return res.status(503).json({ success: false, code: 'BILLING_EVENT_IN_PROGRESS',
          message: 'Billing event is still processing', requestId: req.context?.requestId || '' });
      }
      return res.status(200).json({
        success: true,
        received: true,
        duplicate: Boolean(processingResult?.duplicate),
      });
    } catch (error) {
      safeConsole.error("Stripe webhook error:", error.message);
      const signatureFailure = !signatureVerified || error.type === 'StripeSignatureVerificationError';
      return res.status(signatureFailure ? 400 : 503).json({
        success: false, code: signatureFailure ? 'INVALID_STRIPE_SIGNATURE' : 'BILLING_PROCESSING_FAILED',
        message: signatureFailure ? 'Stripe signature verification failed' : 'Billing event processing must be retried',
        requestId: req.context?.requestId || '',
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
    const subscription=await syncStripeSubscription({
      stripeSubscription,
      observedSubscription:invoiceGuard.subscription,
      invoiceEvent:{invoice,status:'paid'},
      refreshFromStripe:false,
    });
    return subscription || null;
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
    const subscription=await syncStripeSubscription({
      stripeSubscription,
      observedSubscription:invoiceGuard.subscription,
      invoiceEvent:{invoice,status:'failed'},
      refreshFromStripe:false,
    });
    return subscription || null;
  }
}
