// Stripe legacy and parent-based invoice shapes; expanded objects are valid too.
export const invoiceSubscriptionId = (invoice) => {
  const id = value => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : '';
  return id(invoice?.parent?.subscription_details?.subscription) || id(invoice?.subscription);
};
