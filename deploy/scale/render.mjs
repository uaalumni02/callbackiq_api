import { validateVoiceTopology } from '../../src/config/voiceTopology.js';
import { validateCapacityPlan } from '../../src/config/scaleCapacityPlan.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
const image = process.env.SCALE_IMAGE;
const sha = process.env.RELEASE_SHA;
if (!/^.+@sha256:[a-f0-9]{64}$/.test(image || '') || !/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Set SCALE_IMAGE to an immutable image digest and RELEASE_SHA to the API commit.');
const namespace = process.env.SCALE_NAMESPACE || 'callbackiq-staging';
const host = process.env.SCALE_INGRESS_HOST, tlsSecret = process.env.SCALE_TLS_SECRET;
if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(host || '') || !/^[a-z][a-z0-9-]+$/.test(tlsSecret || '')) throw new Error('Set SCALE_INGRESS_HOST and SCALE_TLS_SECRET for the API/voice ingress');
if (!/^[a-z][a-z0-9-]{0,62}$/.test(namespace)) throw new Error('Invalid namespace');
if (!process.env.SCALE_CAPACITY_PLAN) throw new Error('SCALE_CAPACITY_PLAN must name a measured capacity plan; use deploy/scale/capacity-plan.example.json as the schema.');
const planBytes = await fs.readFile(process.env.SCALE_CAPACITY_PLAN);
const capacityPlan = JSON.parse(planBytes);
const smsSizing = validateCapacityPlan(capacityPlan, { apiSha: sha });
if (smsSizing.errors.length) throw new Error(`Invalid measured capacity plan: ${smsSizing.errors.join('; ')}`);
if (capacityPlan.target.voiceSessions > 350) throw new Error('This topology is sized for 350 voice sessions; larger targets require a separately reviewed voice topology.');
const capacityPlanSha256 = crypto.createHash('sha256').update(planBytes).digest('hex');
const rows = [
  ['api', 4, 40, 1000, '1Gi'], ['voice', 6, 20, 2000, '2Gi'],
  ['worker-sms', smsSizing.requiredReplicas, 30, 1000, '1Gi'], ['worker-ops', 2, 10, 250, '512Mi'],
  ...['automation', 'lifecycle', 'a2p', 'maintenance', 'voice-usage'].map(x => [`worker-${x}`, 2, 10, 250, '512Mi']),
];
for (const row of rows) {
  const key = `SCALE_REPLICAS_${row[0].toUpperCase().replaceAll('-', '_')}`;
  if (process.env[key]) {
    const count = Number(process.env[key]);
    if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error(`${key} must be 2–100`);
    row[1] = count;
  }
}
if (rows.find(x => x[0] === 'worker-sms')[1] < smsSizing.requiredReplicas) throw new Error(`SMS sizing requires at least ${smsSizing.requiredReplicas} replicas`);
if (smsSizing.requiredReplicas > 100) throw new Error('Measured SMS demand exceeds supported replica planning range; revise capacity before rendering.');
const autoscale = process.env.SCALE_AUTOSCALING_ENABLED === 'true';
if (autoscale && process.env.SCALE_SMS_METRICS_ADAPTER_READY !== 'true') throw new Error('SMS autoscaling requires an installed external metrics adapter for callbackiq_sms_oldest_job_age_seconds');
const maxima = new Map(rows.map(([role, replicas]) => [role, replicas]));
if (autoscale) for (const role of ['api', 'worker-sms']) {
  const maximum = Number(process.env[`SCALE_MAX_REPLICAS_${role.toUpperCase().replaceAll('-', '_')}`]);
  if (!Number.isInteger(maximum) || maximum < maxima.get(role) || maximum > 100) throw new Error(`Declare a valid autoscaling maximum for ${role}`);
  maxima.set(role, maximum);
}
if ((rows.find(x => x[0] === 'voice')[1] - 1) * 75 < capacityPlan.target.voiceSessions) throw new Error('Voice replicas must preserve N-1 active-turn capacity.');
// Reserve provider concurrency for voice turns AND every SMS lane at the
// maximum autoscaled fleet size, including one rolling replacement per role.
const combinedAiConcurrency = (maxima.get('worker-sms') + 1) * 25 + 400 + capacityPlan.providerDemand.otherAiConcurrent;
if (capacityPlan.providerQuota.aiConcurrent < combinedAiConcurrency) throw new Error(`Combined SMS/voice AI concurrency requires ${combinedAiConcurrency} provider slots at rollout/autoscaling maximum`);
// Include one surge pod for EVERY deployment plus 50 operator/migration connections.
const connections = rows.reduce((n, [role, , pool]) => n + (maxima.get(role) + 1) * pool, 50);
if (!(Number(process.env.SCALE_MONGO_CONNECTION_BUDGET) >= connections)) throw new Error(`SCALE_MONGO_CONNECTION_BUDGET must cover ${connections} allocated connections; confirm actual database capacity.`);
const config = { NODE_ENV: 'production', SCALE_PROFILE: 'business-1000-voice-350',
  SCALE_TARGET_BUSINESSES: String(capacityPlan.target.businesses), SCALE_TARGET_VOICE: String(capacityPlan.target.voiceSessions), SCALE_VOICE_REPLICAS: '6', SCALE_SMS_REPLICAS: '12', API_INSTANCE_COUNT: '4',
  VOICE_INSTANCE_MAX_SESSIONS: '100', VOICE_INSTANCE_MAX_PENDING: '100', VOICE_INSTANCE_MAX_AI_TURNS: '75',
  VOICE_FLEET_MAX_SESSIONS: '450', VOICE_FLEET_MAX_AI_TURNS: '400', VOICE_TURN_QUEUE_WAIT_MS: '1000', VOICE_TURN_QUEUE_MAX: '100',
  VOICE_DRAIN_TIMEOUT_MS: '610000', DEPLOY_TERMINATION_GRACE_MS: '660000', WORKER_DRAIN_TIMEOUT_MS: '120000',
  SMS_PROCESSING_CONCURRENCY: '25', SMS_TENANT_MAX_CONCURRENCY: '5', OWNER_QUERY_MAX_TIME_MS: '3000', SCALE_CACHE_MAX_LOADERS: '8', SMS_PROCESSING_BATCH_SIZE: '100', SMS_LIFECYCLE_CONCURRENCY: '10', SMS_LIFECYCLE_BATCH_SIZE: '250', SMS_LIFECYCLE_INTERVAL_MS: '15000',
  SOCKET_REDIS_REQUIRED: 'true', SCALE_CACHE_NAMESPACE: `callbackiq:${namespace}`, COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED: 'true',
  AUTOMATION_WORKER_ENABLED: 'true', STAFF_NOTIFICATION_SMS_ENABLED: 'true', APPOINTMENT_NOTIFICATION_CONCURRENCY: '3', APPOINTMENT_NOTIFICATION_BATCH_SIZE: '100', RECOVERY_SMS_ASYNC_ENABLED: 'true', STAFF_NOTIFICATION_EMAIL_ENABLED: 'true', OPS_PAGING_ENABLED: 'true',
  RUNTIME_METRICS_LOG_ENABLED: 'true', MONGO_MIN_POOL_SIZE: '2', MONGO_MAX_CONNECTING: '4',
  SCALE_MONGO_DECLARED_CONNECTIONS: String(connections), SCALE_MONGO_CONNECTION_BUDGET: process.env.SCALE_MONGO_CONNECTION_BUDGET,
  SCALE_IMAGE_DIGEST: image, SCALE_CAPACITY_PLAN_SHA256: capacityPlanSha256, SCALE_CAPACITY_PROVIDER_MODE: capacityPlan.providerMode,
  SCALE_COMBINED_AI_CONCURRENCY: String(combinedAiConcurrency),
  SCALE_SMS_REQUIRED_REPLICAS: String(smsSizing.requiredReplicas), SCALE_SMS_PROCESSING_P95_MS: String(smsSizing.processingP95Ms),
  SCALE_SMS_TARGET_UTILIZATION: String(capacityPlan.utilization), SCALE_TARGET_SMS_RPS: String(capacityPlan.target.smsPerSecond),
  PROVIDER_VOICE_SESSION_QUOTA: String(capacityPlan.providerQuota.voiceSessions), PROVIDER_AI_CONCURRENT_QUOTA: String(capacityPlan.providerQuota.aiConcurrent), RELEASE_SHA: sha };
config.API_INSTANCE_COUNT = String(rows.find(x => x[0] === 'api')[1]);
config.SCALE_VOICE_REPLICAS = String(rows.find(x => x[0] === 'voice')[1]);
config.SCALE_SMS_REPLICAS = String(rows.find(x => x[0] === 'worker-sms')[1]);
const items = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'callbackiq-scale', namespace }, data: config }];
for (const [role, replicas, pool, cpu, memory] of rows) {
  const labels = { app: 'callbackiq', role };
  const worker = role.startsWith('worker');
  const probe = worker ? { exec: { command: ['node', 'scripts/worker-health.mjs', '--ready'] } } : { httpGet: { path: '/api/health/ready', port: 3000 } };
  const live = worker ? { exec: { command: ['node', 'scripts/worker-health.mjs'] } } : { httpGet: { path: '/api/health/live', port: 3000 } };
  items.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: `callbackiq-${role}`, namespace }, spec: {
    replicas, revisionHistoryLimit: 3, selector: { matchLabels: labels }, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
    template: { metadata: { labels }, spec: { terminationGracePeriodSeconds: worker ? 180 : 660,
      automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: labels } }],
      containers: [{ name: 'app', image, command: ['node', worker ? 'build/worker.js' : 'build/server.js'],
        envFrom: [{ secretRef: { name: 'callbackiq-runtime' } }, { configMapRef: { name: 'callbackiq-scale' } }],
        env: [{ name: 'PROCESS_ROLE', value: role }, { name: 'MONGO_MAX_POOL_SIZE', value: String(pool) }, { name: 'VOICE_RELAY_ENABLED', value: role === 'voice' ? 'true' : 'false' }],
        ports: worker ? [] : [{ containerPort: 3000 }],
        resources: { requests: { cpu: `${cpu}m`, memory }, limits: { cpu: `${cpu * 2}m`, memory } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
        startupProbe: { ...probe, periodSeconds: 5, failureThreshold: 36 },
        readinessProbe: { ...probe, periodSeconds: 5, timeoutSeconds: 4, failureThreshold: 2 },
        livenessProbe: { ...live, periodSeconds: 10, timeoutSeconds: 4, failureThreshold: 6 },
      }], volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }] } },
  } });
  if (autoscale && ['api', 'worker-sms'].includes(role)) items.push({ apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
    metadata: { name: `callbackiq-${role}`, namespace }, spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: `callbackiq-${role}` },
      minReplicas: replicas, maxReplicas: maxima.get(role),
      metrics: role === 'api' ? [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 65 } } }]
        : [{ type: 'External', external: { metric: { name: 'callbackiq_sms_oldest_job_age_seconds', selector: { matchLabels: { deployment: namespace } } }, target: { type: 'Value', value: '5' } } }],
      behavior: { scaleDown: { stabilizationWindowSeconds: 600, policies: [{ type: 'Pods', value: 1, periodSeconds: 60 }] }, scaleUp: { stabilizationWindowSeconds: 0 } },
    } });
  items.push({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: `callbackiq-${role}`, namespace }, spec: { maxUnavailable: 1, selector: { matchLabels: labels } } });
  if (!worker) items.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: `callbackiq-${role}`, namespace }, spec: {
    selector: labels, ports: [{ port: 3000, targetPort: 3000 }],
  } });
}
const output = process.env.SCALE_DEPLOYMENT_FILE || 'scale-deployment.json';
items.push({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'callbackiq', namespace, annotations: {
  'nginx.ingress.kubernetes.io/proxy-read-timeout': '660', 'nginx.ingress.kubernetes.io/proxy-send-timeout': '660',
  'nginx.ingress.kubernetes.io/affinity': 'cookie', 'nginx.ingress.kubernetes.io/session-cookie-name': 'callbackiq-route',
  'nginx.ingress.kubernetes.io/session-cookie-secure': 'true',
} }, spec: { ingressClassName: process.env.SCALE_INGRESS_CLASS || 'nginx', tls: [{ hosts: [host], secretName: tlsSecret }], rules: [{ host, http: { paths: [
  ['/ws/voice', 'Prefix', 'voice'],
  ...['voice', 'voice-fallback', 'voice-overflow', 'voice-complete', 'voice-transfer-complete', 'voice-staff-screen', 'voice-staff-screen-decision'].map(route => [`/api/twilio/${route}`, 'Exact', 'voice']),
  ['/api/twilio/tracking-call-complete', 'Exact', 'voice'], ['/', 'Prefix', 'api'],
].map(([path, pathType, role]) => ({ path, pathType, backend: { service: { name: `callbackiq-${role}`, port: { number: 3000 } } } })) } }] } });
const topologyCheck = validateVoiceTopology({ items });
if (!topologyCheck.passed) throw new Error(topologyCheck.errors.join('; '));
await fs.writeFile(output, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2) + '\n');
console.log(JSON.stringify({ output, mongoConnectionsIncludingSurge: connections, smsSizing, capacityPlanSha256, providerMode: capacityPlan.providerMode, autoscalingEnabled: autoscale, note: 'Sizing is a starting configuration, not certified throughput. Secrets and ingress must be configured before applying.' }));
