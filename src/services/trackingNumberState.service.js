import { AsyncLocalStorage } from 'node:async_hooks';
import Business from '../models/business.js';
import OperationLease from '../models/operationLease.js';
import ReleaseIntent from '../models/trackingNumberReleaseIntent.js';
import { conditionalWrite } from './database/conditionalWrite.js';
import { acquireOperationLease, releaseOperationLease } from './operationLease.service.js';

const context = new AsyncLocalStorage();
export const trackingSelect = '+trackingNumber.providerSid +messagingCompliance.messagingServiceSid';
export const loadTrackingBusiness = id => Business.findById(id?._id || id).select(trackingSelect);
export const trackingError = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
export function observeTrackingState(business) {
  const tracking = business.trackingNumber;
  const stored = field => tracking?.$isDefault?.(field) ? undefined : tracking?.[field];
  return { 'trackingNumber.revision': stored('revision'), 'trackingNumber.providerSid': stored('providerSid'),
    'trackingNumber.status': stored('status'), phone: business.phone };
}
export async function assertTrackingClaim() {
  const scope = context.getStore();
  if (!scope || !await OperationLease.exists({ _id: scope.lease.key, token: scope.lease.token, expiresAt: { $gt: new Date() } })) {
    throw trackingError('TRACKING_NUMBER_CLAIM_LOST', 'Tracking-number operation lost its claim. Reload before retrying.');
  }
  return scope;
}
export async function writeTrackingState(business, update) {
  await assertTrackingClaim();
  return conditionalWrite({ model: Business, identity: { _id: business._id }, observed: observeTrackingState(business),
    select: trackingSelect, update: { ...update, $inc: { ...update.$inc, 'trackingNumber.revision': 1 } } });
}
export async function completeTrackingState(business, update) {
  const result = await writeTrackingState(business, update);
  if (!result.applied) throw Object.assign(trackingError('TRACKING_NUMBER_STATE_CHANGED',
    'Tracking-number state changed while work was running. Reload before retrying.'), { current: result.current });
  return result.current;
}
/** Nested provision stages reuse one business claim and one revision fence. */
export async function withTrackingNumberOperation(businessOrId, kind, operation) {
  const id = businessOrId?._id || businessOrId, parent = context.getStore();
  const run = business => {
    if (kind !== 'release' && business.accountLifecycle?.status === 'deleting') {
      throw trackingError('BUSINESS_DELETION_IN_PROGRESS', 'Business deletion must finish before provisioning.');
    }
    return operation(business);
  };
  if (parent?.businessId === String(id)) { await assertTrackingClaim(); return run(await loadTrackingBusiness(id)); }
  const lease = await acquireOperationLease({ key: `tracking-number:${id}`,
    ttlMs: Number(process.env.TRACKING_NUMBER_PROVISIONING_LEASE_MS || 120000),
    waitMs: Number(process.env.TRACKING_NUMBER_PROVISIONING_WAIT_MS || 3000), busyCode: 'TRACKING_NUMBER_PROVISIONING_IN_PROGRESS' });
  try {
    return await context.run({ businessId: String(id), lease }, async () => {
      const current = await loadTrackingBusiness(id);
      if (!current) throw trackingError('BUSINESS_NOT_FOUND', 'Business not found.', 404);
      // Advance the fence even when unresolved external work blocks this holder.
      const reserved = await completeTrackingState(current, { $inc: {} });
      if (kind !== 'release' && await ReleaseIntent.exists({ business: id, status: { $in: ['pending','dispatching','uncertain'] } })) {
        throw trackingError('TRACKING_NUMBER_RELEASE_UNCERTAIN', 'An unresolved release requires reconciliation.', 503);
      }
      return run(reserved);
    });
  } finally { await releaseOperationLease(lease); }
}
