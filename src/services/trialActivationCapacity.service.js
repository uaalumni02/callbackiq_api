import Subscription from '../models/subscription.js';

const configuredLimit = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 503 }); };

export async function assertTrialActivationCapacity(now = new Date(), preparingBusinessId) {
  const dailyLimit = configuredLimit('TRIAL_MAX_NEW_TRIALS_PER_DAY', 10);
  const concurrentLimit = configuredLimit('TRIAL_MAX_CONCURRENT_ACTIVE', 25);
  const numberLimit = configuredLimit('TRIAL_MAX_TRACKING_NUMBERS_HELD', 40);
  const [daily, concurrent, held] = await Promise.all([
    dailyLimit > 0 ? Subscription.countDocuments({ trialStartedAt: { $gte: new Date(now.getTime() - 86400000) }, trialUsedAt: { $ne: null } }) : 0,
    concurrentLimit > 0 || numberLimit > 0 ? Subscription.countDocuments({ status: 'trialing', trialEndsAt: { $gt: now } }) : 0,
    numberLimit > 0 ? Subscription.countDocuments({ trialNumberReleaseAt: { $gt: now }, status: { $ne: 'active' },
      ...(preparingBusinessId ? { business: { $ne: preparingBusinessId } } : {}),
    }) : 0,
  ]);
  if (dailyLimit > 0 && daily >= dailyLimit) fail('TRIAL_DAILY_CAPACITY_REACHED', 'Free-trial activation is temporarily at capacity. Please try again later or choose a paid plan.');
  if (concurrentLimit > 0 && concurrent >= concurrentLimit) fail('TRIAL_CONCURRENT_CAPACITY_REACHED', 'Free-trial capacity is temporarily full. Please try again later or choose a paid plan.');
  if (numberLimit > 0 && concurrent + held >= numberLimit) fail('TRIAL_NUMBER_INVENTORY_CAPACITY_REACHED', 'Free-trial tracking-number inventory is temporarily at capacity. Please try again later or choose a paid plan.');
}
