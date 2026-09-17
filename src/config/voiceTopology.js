// Static Kubernetes topology checks. They validate declarations, not live routing.
export function validateVoiceTopology(manifest) {
  const errors = [], items = manifest?.items || [];
  const config = items.find(x => x.kind === 'ConfigMap' && x.metadata?.name === 'callbackiq-scale')?.data || {};
  const voice = items.find(x => x.kind === 'Deployment' && x.metadata?.name === 'callbackiq-voice');
  const api = items.find(x => x.kind === 'Deployment' && x.metadata?.name === 'callbackiq-api');
  const target = Number(config.SCALE_TARGET_VOICE);
  const replicas = voice?.spec?.replicas;
  const sessions = Number(config.VOICE_INSTANCE_MAX_SESSIONS), turns = Number(config.VOICE_INSTANCE_MAX_AI_TURNS);
  for (const [key, value] of Object.entries({ target, replicas, sessions, turns })) if (!Number.isInteger(value) || value < 1) errors.push(`Invalid voice ${key}`);
  if (!(target >= 350 && (replicas - 1) * sessions >= target && (replicas - 1) * turns >= target)) errors.push('Voice N-1 session/turn capacity is below target');
  if (Number(config.SCALE_VOICE_REPLICAS) !== replicas || Number(config.API_INSTANCE_COUNT) !== api?.spec?.replicas) errors.push('Replica declarations differ from deployments');
  for (const [limit, quota] of [['VOICE_FLEET_MAX_SESSIONS', 'PROVIDER_VOICE_SESSION_QUOTA'], ['VOICE_FLEET_MAX_AI_TURNS', 'PROVIDER_AI_CONCURRENT_QUOTA']]) {
    const value = Number(config[limit]);
    if (!Number.isInteger(value) || value < target || !(value <= Number(config[quota]))) errors.push(`Invalid fleet budget: ${limit}`);
  }
  if (config.SOCKET_REDIS_REQUIRED !== 'true' || !config.SCALE_CACHE_NAMESPACE) errors.push('Shared Redis coordination must be required and namespaced');
  for (const deployment of [voice, api]) {
    const container = deployment?.spec?.template?.spec?.containers?.[0];
    const role = deployment === voice ? 'voice' : 'api';
    const vars = Object.fromEntries((container?.env || []).map(x => [x.name, x.value]));
    if (vars.PROCESS_ROLE !== role || vars.VOICE_RELAY_ENABLED !== (role === 'voice' ? 'true' : 'false')) errors.push(`Invalid ${role} role separation`);
    if (!container?.envFrom?.some(x => x.configMapRef?.name === 'callbackiq-scale') || !container?.envFrom?.some(x => x.secretRef?.name === 'callbackiq-runtime')) errors.push(`Missing shared runtime configuration: ${role}`);
    // Prevent a pod overriding the shared coordination or capacity configuration.
    if (Object.keys(vars).some(key => /^(REDIS_URL|SOCKET_REDIS_URL|VOICE_CAPACITY_REDIS_URL|SCALE_CACHE_NAMESPACE|VOICE_FLEET_MAX_|VOICE_INSTANCE_MAX_)/.test(key))) errors.push(`Per-pod coordination/capacity override: ${role}`);
  }
  if (!((voice?.spec?.template?.spec?.terminationGracePeriodSeconds || 0) * 1000 >= Number(config.VOICE_DRAIN_TIMEOUT_MS) + 30000)) errors.push('Voice termination grace is shorter than drain plus cleanup');
  const service = items.find(x => x.kind === 'Service' && x.metadata?.name === 'callbackiq-voice');
  if (service?.spec?.selector?.role !== 'voice' || service?.spec?.sessionAffinity === 'ClientIP') errors.push('Voice service must route to voice replicas without source-IP pinning');
  const ingress = items.find(x => x.kind === 'Ingress');
  const paths = (ingress?.spec?.rules || []).flatMap(x => x.http?.paths || []);
  if (!paths.some(x => x.path === '/ws/voice' && x.backend?.service?.name === 'callbackiq-voice')) errors.push('WebSocket ingress must route to voice service');
  if (!(Number(ingress?.metadata?.annotations?.['nginx.ingress.kubernetes.io/proxy-read-timeout']) >= 660)) errors.push('WebSocket ingress timeout must cover a complete call');
  return { passed: errors.length === 0, errors, liveInfrastructureVerified: false };
}
