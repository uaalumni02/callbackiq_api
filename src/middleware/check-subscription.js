import customerAccess from './customer-access.js';

/*
 * Default application gate: only trialing, active, or paid-through-period-end
 * businesses may use provider actions and automation. Billing/account routes
 * should continue to use checkAuth directly so customers can recover access.
 */
const checkSubscription = customerAccess;

export default checkSubscription;
