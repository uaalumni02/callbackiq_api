// A preparation reservation is deliberately insufficient for application access.
export const hasTrialPreparation = (subscription, now = new Date()) => Boolean(
  subscription?.status === 'none' && !subscription.trialUsedAt &&
  !subscription.stripeSubscriptionId &&
  ['pending', 'ready'].includes(subscription.trialPreparation?.state) &&
  new Date(subscription.trialPreparation.expiresAt) > now,
);

export const trialTelecomReady = business => Boolean(
  business?.isActive !== false && business?.phone &&
  business.trackingNumber?.providerSid && business.trackingNumber.status === 'active' &&
  business.forwardingPhone && business.messagingCompliance?.smsReady === true &&
  business.messagingCompliance.senderAttached === true,
);

export const preparationMessage = subscription => {
  if (subscription?.trialPreparation?.state === 'ready') {
    return 'Your MeekCall number and text messaging are ready. Continue activation to start your 14-day trial.';
  }
  return 'We are preparing your MeekCall number and waiting for text messaging approval. Your 14-day trial has not started. Return here to check readiness and continue activation.';
};
