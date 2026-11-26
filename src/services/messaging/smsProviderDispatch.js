const providerParameters = ({
  normalizedTo,
  normalizedBody,
  configuredMessagingServiceSid,
  configuredFrom,
  forceDirectSender,
  statusCallback,
}) => ({
  to: normalizedTo,
  body: normalizedBody,
  ...(configuredMessagingServiceSid
    ? { messagingServiceSid: configuredMessagingServiceSid }
    : {}),
  ...(forceDirectSender || !configuredMessagingServiceSid
    ? { from: configuredFrom }
    : {}),
  ...(statusCallback ? { statusCallback } : {}),
});
const loadProviderPolicy = async () => ({
  ...(await import("../budgets/providerBudget.service.js")),
  ...(await import("../providerEntitlement.service.js")),
});
/** Creates an isolated dispatcher with an injected policy loader; the application uses the fail-closed default. */
export function createSmsProviderDispatcher(loadPolicy = loadProviderPolicy) {
  return async function dispatchSmsProvider(input) {
    const {
      client,
      businessId,
      params,
      operationKey,
      segmentCount,
      ...delivery
    } = input;
    let providerStarted = false;
    try {
      const { reserveProviderBudget, dispatchEntitledProvider } =
        await loadPolicy();
      return await dispatchEntitledProvider({
        businessId,
        channel: "sms",
        dispatch: async () => {
          await reserveProviderBudget({
            businessId,
            metric: "sms",
            amount: segmentCount,
            key: operationKey,
          });
          return dispatchEntitledProvider({
            businessId,
            channel: "sms",
            dispatch: () => {
              providerStarted = true;
              return client.messages.create(
                params || providerParameters(delivery),
              );
            },
          });
        },
      });
    } catch (error) {
      if (!providerStarted && error && typeof error === "object")
        error.providerDispatchNotStarted = true;
      throw error;
    }
  };
}
/** Sends only after fresh entitlement, atomic plan/fleet reservation, and a second entitlement read. */
export const dispatchSmsProvider = createSmsProviderDispatcher();
