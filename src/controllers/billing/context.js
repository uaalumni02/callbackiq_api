import { canonicalInvoiceProjection, stripePeriodDates } from '../../helpers/billing/stripeSubscriptionSnapshot.js';

import { getDefaultPaymentMethod, getDefaultNextCharge, getPaymentMethodSummary, getNextChargeDetails, mapStripeInvoice } from "../../helpers/billing/stripeBillingDetails.js";

import { invoiceSubscriptionId } from "../../helpers/billing/invoiceSubscriptionId.js";

import { safeConsole } from "../../helpers/logging/safeLogger.js";

import Db from "../../db/db.js";

import Business from "../../models/business.js";

import Subscription from "../../models/subscription.js";

import "../../models/trialRedemption.js";

import { checkoutSchema } from "../../validator/billing.js";

import { getStripeClient } from "../../helpers/stripe/stripeClient.js";

import * as Response from "../../helpers/response/response.js";

import {
  createSubscriptionCheckout,
  extendTrialByAdmin,
  sendTrialLifecycleMessage,
  syncCheckoutSession,
  syncStripeSubscription,
} from "../../services/trialLifecycle.service.js";

import {
  getTrialEligibility,
  TRIAL_PRICE_MONTHLY,
} from "../../helpers/billing/trial.js";

import { processStripeEventOnce } from "../../services/billingEvent.service.js";

import {
  createTrialPaymentMethodCheckout,
  completeTrialPaymentMethodCheckout,
  resumeCanonicalSubscription,
} from "../../services/subscriptionActions.service.js";

import {
  assertCanonicalIsOnlyLiveSubscription,
  guardInvoiceAgainstCanonicalSubscription,
} from "../../services/subscriptionIntegrity.service.js";

import {
  ACCESS_LEVELS,
  getSubscriptionAccess,
} from "../../services/subscriptionAccess.service.js";

import {
  assertTrialIdentityVerified,
  securityGateEnabled,
} from "../../services/trialIdentityVerification.service.js";

import { enforceTrialActivationRisk } from "../../services/trialRisk.service.js";

import { verifyTurnstileToken } from "../../helpers/security/turnstile.js";

const getClientUrl = () => {
  return process.env.CLIENT_URL || "http://localhost:3001";
};

const isAccessStatus = (status) => {
  return ["trialing", "active"].includes(status);
};

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

export { Response, assertTrialIdentityVerified, createSubscriptionCheckout, enforceTrialActivationRisk, getRequestBusiness, safeConsole, securityGateEnabled, verifyTurnstileToken, checkoutSchema, ACCESS_LEVELS, Subscription, getRequestSubscription, getStripeClient, getSubscriptionAccess, syncCheckoutSession, createTrialPaymentMethodCheckout, resumeCanonicalSubscription, expireTrialIfNeeded, TRIAL_PRICE_MONTHLY, getDefaultNextCharge, getDefaultPaymentMethod, getNextChargeDetails, getPaymentMethodSummary, getTrialEligibility, isAccessStatus, mapStripeInvoice, assertCanonicalIsOnlyLiveSubscription, getClientUrl, Db, stripePeriodDates, processStripeEventOnce, sendTrialLifecycleMessage, completeTrialPaymentMethodCheckout, syncStripeSubscription, canonicalInvoiceProjection, guardInvoiceAgainstCanonicalSubscription, invoiceSubscriptionId, extendTrialByAdmin, Business };
