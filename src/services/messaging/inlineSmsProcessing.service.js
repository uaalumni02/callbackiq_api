import { withDistributedLease } from '../distributedLease.service.js';
import { processInboundSmsJob } from './inboundSmsJobProcessor.service.js';

// The synchronous test harness must serialize on the same key as the real worker.
// A busy lease leaves the durable queue entry available to the normal worker.
export async function processInlineInboundSmsJob(job, dependencies = {}) {
  const lease = dependencies.withDistributedLease || withDistributedLease;
  const processor = dependencies.processInboundSmsJob || processInboundSmsJob;
  const result = await lease(`sms-conversation:${job.conversation}`, () => processor(job), {
    ttlMs: Math.max(15000, Number(process.env.SMS_CONVERSATION_LEASE_MS || process.env.SMS_PROCESSING_LEASE_MS || 60000)),
    metadata: { worker: 'sms_inline_test', jobId: String(job._id), businessId: String(job.business) },
  });
  return result.acquired ? result.value : { skipped: true, reason: 'conversation_lease_busy' };
}
