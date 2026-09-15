import fs from 'node:fs/promises';
const image = process.env.SCALE_IMAGE;
const sha = process.env.RELEASE_SHA;
if (!/^.+@sha256:[a-f0-9]{64}$/.test(image || '') || !/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Set SCALE_IMAGE to an immutable image digest and RELEASE_SHA to the API commit.');
const namespace = process.env.SCALE_NAMESPACE || 'callbackiq-staging';
const host = process.env.SCALE_INGRESS_HOST, tlsSecret = process.env.SCALE_TLS_SECRET;
if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(host || '') || !/^[a-z][a-z0-9-]+$/.test(tlsSecret || '')) throw new Error('Set SCALE_INGRESS_HOST and SCALE_TLS_SECRET for the API/voice ingress');
if (!/^[a-z][a-z0-9-]{0,62}$/.test(namespace)) throw new Error('Invalid namespace');
const rows = [
  ['api', 4, 40, 1000, '1Gi'], ['voice', 6, 20, 2000, '2Gi'],
  ['worker-sms', 12, 30, 1000, '1Gi'], ['worker-ops', 2, 10, 250, '512Mi'],
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
// Include one surge pod for EVERY deployment plus 50 operator/migration connections.
const connections = rows.reduce((n, [, count, pool]) => n + (count + 1) * pool, 50);
const config = { NODE_ENV: 'production', SCALE_PROFILE: 'business-1000-voice-350',
  SCALE_TARGET_BUSINESSES: '1001', SCALE_TARGET_VOICE: '350', SCALE_VOICE_REPLICAS: '6', SCALE_SMS_REPLICAS: '12', API_INSTANCE_COUNT: '4',
  VOICE_INSTANCE_MAX_SESSIONS: '100', VOICE_INSTANCE_MAX_PENDING: '100', VOICE_INSTANCE_MAX_AI_TURNS: '75',
  VOICE_FLEET_MAX_SESSIONS: '450', VOICE_FLEET_MAX_AI_TURNS: '400', VOICE_TURN_QUEUE_WAIT_MS: '1000', VOICE_TURN_QUEUE_MAX: '100',
  VOICE_DRAIN_TIMEOUT_MS: '610000', DEPLOY_TERMINATION_GRACE_MS: '660000', WORKER_DRAIN_TIMEOUT_MS: '120000',
  SMS_PROCESSING_CONCURRENCY: '25', SMS_PROCESSING_BATCH_SIZE: '100', SMS_LIFECYCLE_CONCURRENCY: '10', SMS_LIFECYCLE_BATCH_SIZE: '250', SMS_LIFECYCLE_INTERVAL_MS: '15000',
  SOCKET_REDIS_REQUIRED: 'true', SCALE_CACHE_NAMESPACE: `callbackiq:${namespace}`, COMMUNICATION_ROUTE_RATE_LIMIT_FAIL_CLOSED: 'true',
  RECOVERY_SMS_ASYNC_ENABLED: 'true', STAFF_NOTIFICATION_EMAIL_ENABLED: 'true', OPS_PAGING_ENABLED: 'true',
  RUNTIME_METRICS_LOG_ENABLED: 'true', MONGO_MIN_POOL_SIZE: '2', MONGO_MAX_CONNECTING: '4',
  SCALE_MONGO_DECLARED_CONNECTIONS: String(connections), RELEASE_SHA: sha };
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
        envFrom: [{ configMapRef: { name: 'callbackiq-scale' } }, { secretRef: { name: 'callbackiq-runtime' } }],
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
await fs.writeFile(output, JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2) + '\n');
console.log(JSON.stringify({ output, mongoConnectionsIncludingSurge: connections, note: 'Sizing is a starting configuration, not certified throughput. Secrets and ingress must be configured before applying.' }));
