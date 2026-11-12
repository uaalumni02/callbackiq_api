import {tenantRepository,tenantContext} from './tenantRepository.js';
import { safeConsole } from "../../helpers/logging/safeLogger.js";

  // ----- Subscription / Billing methods -----

export async function getSubscriptionByBusiness(model, businessId, { populateBusiness = true } = {}) {
    return tenantRepository(model,tenantContext(businessId)).first({}, {populate:populateBusiness?[{path:'business',select:'businessName businessType phone email'}]:[]});
  }

export async function getSubscriptionByStripeCustomer(model, stripeCustomerId) {
    try {
      return await model
        .findOne({ stripeCustomerId })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      safeConsole.error("Error fetching subscription by Stripe customer:", error);
      throw error;
    }
  }

export async function getSubscriptionByStripeSubscription(
    model,
    stripeSubscriptionId,
  ) {
    try {
      return await model
        .findOne({ stripeSubscriptionId })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      safeConsole.error(
        "Error fetching subscription by Stripe subscription:",
        error,
      );
      throw error;
    }
  }

export async function upsertSubscriptionByBusiness(model, businessId, data) {
    try {
      return await model
        .findOneAndUpdate(
          { business: businessId },
          {
            ...data,
            business: businessId,
          },
          {
            returnDocument: "after",
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        )
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      safeConsole.error("Error upserting subscription:", error);
      throw error;
    }
  }

export async function updateSubscriptionByStripeSubscription(
    model,
    stripeSubscriptionId,
    data,
  ) {
    try {
      return await model
        .findOneAndUpdate({ stripeSubscriptionId }, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      safeConsole.error(
        "Error updating subscription by Stripe subscription:",
        error,
      );
      throw error;
    }
  }

