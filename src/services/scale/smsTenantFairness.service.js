import { withDistributedLease } from '../distributedLease.service.js';
// A bounded number of Mongo-backed slots per business is shared by every SMS
// replica. Expiring, renewed ownership also fences a paused or crashed worker.
export const tenantSmsConcurrency = () => Math.max(1, Math.min(25, Math.floor(Number(process.env.SMS_TENANT_MAX_CONCURRENCY) || 5)));
export async function withSmsTenantSlot(businessId, operation) {
  const slots = tenantSmsConcurrency();
  const start = Math.floor(Math.random() * slots);
  for (let i = 0; i < slots; i++) {
    const lease = await withDistributedLease(`sms-tenant:${businessId}:${(start + i) % slots}`, operation,
      { ttlMs: Math.max(15000, Number(process.env.SMS_PROCESSING_LEASE_MS) || 60000), metadata: { worker: 'sms_tenant_admission', businessId: String(businessId) } });
    if (lease.acquired) return lease;
  }
  return { acquired: false };
}
const samples = [];
let deferred = 0;
export const recordSmsProcessingDuration = ms => { samples.push(ms); if (samples.length > 2000) samples.shift(); };
export const recordSmsTenantDeferral = () => { deferred++; };
export function smsProcessingMetrics() {
  const sorted = [...samples].sort((a,b) => a-b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { sampledJobs: sorted.length, tenantDeferrals: deferred, tenantConcurrency: tenantSmsConcurrency(),
    processingMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) } };
}
