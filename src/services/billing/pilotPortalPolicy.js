/** Verifies a payment-method/invoice portal cannot alter subscription plans or quantities. */
export async function assertPilotPortalConfiguration(stripe, configurationId) {
  const configuration =
    await stripe.billingPortal?.configurations?.retrieve(configurationId);
  if (
    !configuration?.active ||
    configuration.features?.subscription_update?.enabled !== false
  )
    throw Object.assign(
      new Error("Billing portal configuration requires support review."),
      { code: "PORTAL_CONFIGURATION_UNSAFE", statusCode: 503 },
    );
  return configuration;
}

/** Resolves and verifies the configured restricted portal; missing or permissive configuration fails closed. */
export async function verifiedPilotPortalConfiguration(stripe){
 const id=String(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || '').trim();
 if(!id)throw Object.assign(new Error('Restricted Stripe billing portal configuration is not configured.'),{statusCode:503,code:'STRIPE_PORTAL_CONFIGURATION_REQUIRED'});
 await assertPilotPortalConfiguration(stripe,id);return id;
}
