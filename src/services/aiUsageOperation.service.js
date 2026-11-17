import { randomUUID } from 'node:crypto';
import { reserveAiUsage } from './communicationUsage.service.js';
import { beginCommunicationUsageReservation, markCommunicationProviderDispatch,
  commitCommunicationUsageReservation, releaseCommunicationUsageReservation,
  markCommunicationUsageUncertain } from './communicationUsageReservation.service.js';

const unavailable = () => Object.assign(new Error('AI usage could not be safely recorded.'), {
  code: 'AI_USAGE_UNAVAILABLE', statusCode: 503,
});

// One budget and durable provider-operation boundary for owner-triggered AI work.
export async function runAiUsageOperation({ business, customerPhone, source, prepare }, work) {
  const usage = await reserveAiUsage({ business, customerPhone, throwOnInfrastructureError: true });
  if (!usage.allowed) throw Object.assign(new Error('The AI allowance has been reached.'), {
    statusCode: 429, code: 'AI_USAGE_LIMIT', reason: usage.reason,
  });
  let reservation, dispatched = false;
  try {
    if (usage.degraded || usage.bypassed || !usage.reservations?.length) throw unavailable();
    const claim = await beginCommunicationUsageReservation({ businessId: business._id, usage,
      metric: 'ai_operation', key: `ai:${business._id}:${randomUUID()}`, source });
    reservation = claim?.reservation;
    if (!reservation || claim.replayed) throw unavailable();
    await prepare?.();
    reservation = await markCommunicationProviderDispatch({ reservation });
    dispatched = true;
    const result = await work();
    const committed = await commitCommunicationUsageReservation({ reservation, providerStatus: 'completed' });
    if (!committed) throw unavailable();
    return result;
  } catch (error) {
    const status = Number(error.status || error.statusCode);
    if (!dispatched || status >= 400 && status < 500) {
      await releaseCommunicationUsageReservation({ reservation, usage, reason: 'ai_rejected', providerRejected: dispatched });
    } else {
      // A transport/receipt failure cannot prove that paid work was never accepted.
      await markCommunicationUsageUncertain({ reservation, error });
    }
    throw error;
  }
}
