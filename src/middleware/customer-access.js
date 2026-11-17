import checkActiveBusiness from './check-active-business.js';
import requireSubscriptionAccess from './require-subscription-access.js';

// Only authentication, billing recovery, and support remain reachable without product access.
export const CUSTOMER_ACCESS_EXEMPTIONS = Object.freeze([
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/password-reset(?:\/|$)/,
  /^\/api\/billing(?:\/|$)/,
  /^\/api\/support(?:\/|$)/,
]);
const subscriptionAccess = requireSubscriptionAccess();
const checked = Symbol('customerAccessChecked');

export default async function customerAccess(req, res, next) {
  if (req[checked] || req.user?.role === 'admin') return next();
  const path = String(req.originalUrl || req.path || '').split('?')[0];
  if (CUSTOMER_ACCESS_EXEMPTIONS.some(pattern => pattern.test(path))) return next();
  return checkActiveBusiness(req, res, () => subscriptionAccess(req, res, () => {
    req[checked] = true;
    return next();
  }));
}
