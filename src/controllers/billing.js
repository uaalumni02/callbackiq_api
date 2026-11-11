import BillingCheckoutController from './billing/Checkout.js';
import BillingSubscriptionActionsController from './billing/SubscriptionActions.js';
import BillingReadsController from './billing/Reads.js';
import BillingWebhooksController from './billing/Webhooks.js';
import BillingAdministrationController from './billing/Administration.js';

class BillingController {
  static startFreeTrial(...args) { return BillingCheckoutController.startFreeTrial(...args); }
  static createCheckoutSession(...args) { return BillingCheckoutController.createCheckoutSession(...args); }
  static confirmCheckoutSession(...args) { return BillingCheckoutController.confirmCheckoutSession(...args); }
  static createTrialPaymentMethodSession(...args) { return BillingSubscriptionActionsController.createTrialPaymentMethodSession(...args); }
  static resumeSubscription(...args) { return BillingSubscriptionActionsController.resumeSubscription(...args); }
  static getMySubscriptionAccess(...args) { return BillingReadsController.getMySubscriptionAccess(...args); }
  static getMySubscription(...args) { return BillingReadsController.getMySubscription(...args); }
  static getBillingHistory(...args) { return BillingReadsController.getBillingHistory(...args); }
  static createBillingPortalSession(...args) { return BillingReadsController.createBillingPortalSession(...args); }
  static cancelSubscription(...args) { return BillingSubscriptionActionsController.cancelSubscription(...args); }
  static handleStripeWebhook(req, res) { return BillingWebhooksController.handleStripeWebhook(req, res, BillingController); }
  static handleCheckoutCompleted(...args) { return BillingWebhooksController.handleCheckoutCompleted(...args); }
  static handleSubscriptionUpdated(...args) { return BillingWebhooksController.handleSubscriptionUpdated(...args); }
  static handleInvoicePaid(...args) { return BillingWebhooksController.handleInvoicePaid(...args); }
  static handleInvoicePaymentFailed(...args) { return BillingWebhooksController.handleInvoicePaymentFailed(...args); }
  static adminGrantTrialOverride(...args) { return BillingAdministrationController.adminGrantTrialOverride(...args); }
  static updateAdminCustomerAccountStatus(...args) { return BillingAdministrationController.updateAdminCustomerAccountStatus(...args); }
}

export default BillingController;
