// Opt-in release contract. Values are declarations to validate, not a capacity
// certificate or a substitute for measured provider limits.
export function validateScaleProfile(env = process.env) {
  if (!env.SCALE_PROFILE) return { enabled: false, errors: [] };
  const errors = [];
  const n = key => Number(env[key]);
  const requireNumber = (key, minimum) => {
    if (!Number.isInteger(n(key)) || n(key) < minimum) errors.push(`${key} must be an integer >= ${minimum}`);
  };
  if (env.SCALE_PROFILE !== 'business-1000-voice-350') errors.push('Unknown SCALE_PROFILE');
  for (const [key, minimum] of Object.entries({ SCALE_TARGET_BUSINESSES: 1001, SCALE_TARGET_VOICE: 350,
    SCALE_VOICE_REPLICAS: 2, API_INSTANCE_COUNT: 2, SCALE_SMS_REPLICAS: 2,
    VOICE_INSTANCE_MAX_SESSIONS: 1, VOICE_INSTANCE_MAX_AI_TURNS: 1,
    VOICE_FLEET_MAX_SESSIONS: 350, VOICE_FLEET_MAX_AI_TURNS: 350,
    PROVIDER_VOICE_SESSION_QUOTA: 350, PROVIDER_AI_CONCURRENT_QUOTA: 350,
    SCALE_MONGO_CONNECTION_BUDGET: 1, SCALE_MONGO_DECLARED_CONNECTIONS: 1 })) requireNumber(key, minimum);
  if ((n('SCALE_VOICE_REPLICAS') - 1) * n('VOICE_INSTANCE_MAX_SESSIONS') < n('SCALE_TARGET_VOICE')) errors.push('Voice session capacity must survive loss of one replica');
  if ((n('SCALE_VOICE_REPLICAS') - 1) * n('VOICE_INSTANCE_MAX_AI_TURNS') < n('SCALE_TARGET_VOICE')) errors.push('AI turn capacity must survive loss of one replica');
  if (n('VOICE_FLEET_MAX_SESSIONS') < n('SCALE_TARGET_VOICE') || n('VOICE_FLEET_MAX_AI_TURNS') < n('SCALE_TARGET_VOICE')) errors.push('Fleet limits are below the target');
  if (n('VOICE_FLEET_MAX_SESSIONS') > n('PROVIDER_VOICE_SESSION_QUOTA') || n('VOICE_FLEET_MAX_AI_TURNS') > n('PROVIDER_AI_CONCURRENT_QUOTA')) errors.push('Fleet limits exceed declared provider capacity');
  if (n('SCALE_MONGO_DECLARED_CONNECTIONS') > n('SCALE_MONGO_CONNECTION_BUDGET')) errors.push('Mongo connection allocation exceeds the budget');
  if (!env.REDIS_URL || !env.SCALE_CACHE_NAMESPACE || env.SOCKET_REDIS_REQUIRED !== 'true') errors.push('Shared Redis and an explicit deployment namespace are required');
  if (!['true', 'false'].includes(env.COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED)) errors.push('Choose the webhook coordination outage policy explicitly');
  if (['all', 'worker', undefined].includes(env.PROCESS_ROLE)) errors.push('Use separate API, voice, and purpose-specific workers');
  if (env.PROCESS_ROLE === 'api' && env.VOICE_RELAY_ENABLED !== 'false') errors.push('Disable voice relay on API instances');
  if (env.PROCESS_ROLE === 'voice' && env.VOICE_RELAY_ENABLED !== 'true') errors.push('Enable voice relay on voice instances');
  if (env.RECOVERY_SMS_ASYNC_ENABLED === 'false') errors.push('Durable recovery must remain enabled');
  if (env.STAFF_NOTIFICATION_EMAIL_ENABLED !== 'true' || !env.GMAIL_ADDRESS || !env.GMAIL_PASSWORD) errors.push('Configure owner email notifications');
  if (env.OPS_PAGING_ENABLED !== 'true' || !env.PAGERDUTY_ROUTING_KEY) errors.push('Configure the operations escalation destination');
  if (env.PROCESS_ROLE === 'voice' && !(n('DEPLOY_TERMINATION_GRACE_MS') >= (Number(env.VOICE_DRAIN_TIMEOUT_MS) || 610000) + 30000)) errors.push('Hosting termination grace must exceed voice drain plus cleanup');
  return { enabled: true, errors };
}
export function assertScaleProfile(env = process.env) {
  const result = validateScaleProfile(env);
  if (result.errors.length) throw new Error(`Invalid scale profile: ${result.errors.join('; ')}`);
  return result;
}
