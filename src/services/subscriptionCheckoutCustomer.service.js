import { findExistingStripeCustomerForBusiness } from './subscriptionIntegrity.service.js';

export async function getCheckoutCustomer({ stripe, business, ownerId, subscription }) {
  if (subscription?.stripeCustomerId) return subscription.stripeCustomerId;
  const existing = await findExistingStripeCustomerForBusiness({ stripe, businessId: business._id });
  if (existing?.id) return existing.id;
  const customer = await stripe.customers.create({
    name: business.businessName, email: business.email || undefined,
    metadata: { ownerId: String(ownerId), businessId: String(business._id) },
  }, { idempotencyKey: `callbackiq:customer:${business._id}` });
  return customer.id;
}
