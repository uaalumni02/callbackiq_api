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
const setupFields = new Set(['businessName', 'businessType', 'forwardingPhone', 'timezone', 'smsTemplate', 'setupStep']);
function isTrialSetupRequest(req, path) {
  if (req.method === 'PATCH' && /^\/api\/businesses\/mine\/?$/.test(path)) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return false;
    const fields = Object.keys(req.body);
    return fields.length > 0 && fields.every(field => setupFields.has(field));
  }
  if (req.method === 'GET') return /^\/api\/businesses\/mine\/a2p-registration\/?$/.test(path);
  return req.method === 'POST' && /^\/api\/businesses\/mine\/a2p-registration(?:\/(?:sync|retry-otp))?\/?$/.test(path);
}

const subscriptionAccess = requireSubscriptionAccess(undefined, {
  allowReadOnly: (req,subscription) => subscription?.status === 'past_due' && ['GET','HEAD'].includes(req.method) &&
    (/^\/api\/(?:leads|conversations|messages|calls|appointments|dashboard|alerts|customers|voice-operations|owner)(?:\/|$)/.test(requestPath(req)) || /^\/api\/business-configuration\/owner-settings\/?$/.test(requestPath(req))),
  // A seeded subscription identifies onboarding. Missing records and used trials stay blocked.
  allowSetup: (req, subscription) => subscription?.status === 'none' &&
    ['trial_not_activated', 'trial_preparing'].includes(subscription.lastPaymentStatus) && !subscription.trialUsedAt &&
    subscription.trialCount === 0 && !subscription.stripeSubscriptionId &&
    isTrialSetupRequest(req, requestPath(req)),
});
const checked = Symbol('customerAccessChecked');
const requestPath = req => String(req.originalUrl || req.path || '').split('?')[0];

export default async function customerAccess(req, res, next) {
  if (req[checked] || req.user?.role === 'admin') return next();
  const path = requestPath(req);
  const exemption = CUSTOMER_ACCESS_EXEMPTIONS.find(entry => entry.path.test(path) &&
    (!entry.methods || entry.methods.includes(req.method)));
  if (exemption) return exemption.activeBusiness ? checkActiveBusiness(req, res, next) : next();
  return checkActiveBusiness(req, res, () => subscriptionAccess(req, res, () => {
    req[checked] = true;
    return next();
  }));
}
