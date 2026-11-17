import checkActiveBusiness from './check-active-business.js';
import requireSubscriptionAccess from './require-subscription-access.js';

// Authentication, account closure/billing recovery, and support are the only exemptions.
// Setup prerequisites skip subscription enforcement, never suspension enforcement.
export const CUSTOMER_ACCESS_EXEMPTIONS = Object.freeze([
  { path: /^\/api\/auth(?:\/|$)/ },
  { path: /^\/api\/password-reset(?:\/|$)/ },
  { path: /^\/api\/billing(?:\/|$)/ },
  { path: /^\/api\/support(?:\/|$)/ },
  { path: /^\/api\/businesses\/?$/, methods: ['POST'] }, // authenticated account bootstrap
  { path: /^\/api\/businesses\/mine\/?$/, methods: ['GET', 'DELETE'] }, // account identity / closure
  { path: /^\/api\/businesses\/mine\/phone-verification\/(?:start|check)\/?$/, methods: ['POST'], activeBusiness: true },
  { path: /^\/api\/businesses\/mine\/readiness\/?$/, methods: ['GET'], activeBusiness: true },
  { path: /^\/api\/businesses\/mine\/setup-progress\/?$/, methods: ['PATCH'], activeBusiness: true },
]);
const subscriptionAccess = requireSubscriptionAccess();
const checked = Symbol('customerAccessChecked');

export default async function customerAccess(req, res, next) {
  if (req[checked] || req.user?.role === 'admin') return next();
  const path = String(req.originalUrl || req.path || '').split('?')[0];
  const exemption = CUSTOMER_ACCESS_EXEMPTIONS.find(entry => entry.path.test(path) &&
    (!entry.methods || entry.methods.includes(req.method)));
  if (exemption) return exemption.activeBusiness ? checkActiveBusiness(req, res, next) : next();
  return checkActiveBusiness(req, res, () => subscriptionAccess(req, res, () => {
    req[checked] = true;
    return next();
  }));
}
