# Runtime inputs for the scale deployment

**September 16 update:** follow `docs/SCALE_CAPACITY_RELEASE_2026_09_16.md`. A measured `SCALE_CAPACITY_PLAN` is now mandatory; the sample below omits those required inputs and will not render until supplied. The measured renderer supersedes the historical initial SMS replica count and sizing formula described below.

The renderer creates application workloads and ingress. It does not purchase servers, create Mongo/Redis, provision Twilio numbers, enroll A2P campaigns, set provider quotas, create TLS certificates, or deploy the frontend. Those are externally managed prerequisites.

Use an existing managed Kubernetes cluster with enough schedulable capacity and an installed ingress-nginx controller, a Mongo replica set with backups, and shared managed Redis. You may translate this topology to another host, but its WebSocket routing and termination grace must match. Do not move a production deployment merely by running this renderer.

Supply the existing runtime settings through a secret named `callbackiq-runtime` in the selected namespace. Create it using your secret manager; do not commit secret YAML. Preserve all existing validated Twilio, OpenAI, Stripe, A2P, email and Google integration settings.

Additional required inputs:

| Input | Source |
| --- | --- |
| MONGO_URL | Dedicated deployment Mongo replica-set URI; avoid defining a conflicting MONGODB_URI |
| REDIS_URL | Dedicated/shared deployment Redis connection with required adapter/Lua permissions |
| PROVIDER_VOICE_SESSION_QUOTA | Provider-confirmed capacity, at least the configured fleet session limit (450 in the template) |
| PROVIDER_AI_CONCURRENT_QUOTA | Load-tested simultaneous AI requests allowed by your account's request/token budgets; at least 400 in the template |
| SCALE_MONGO_CONNECTION_BUDGET | Measured connection allocation for this fleet; renderer prints the allocation including surge and operator reserve |
| PAGERDUTY_ROUTING_KEY | Events API v2 integration for the staffed CallBackIQ operations service |
| GMAIL_ADDRESS / GMAIL_PASSWORD | Existing mail transport credentials, validated against the expected alert volume |
| CLIENT_URL / PUBLIC_API_URL | Actual HTTPS app/API origins; PUBLIC_API_URL must match the ingress host |
| VOICE_HTTP_PUBLIC_URL / VOICE_WEBSOCKET_PUBLIC_URL | Public voice URLs routed by the ingress; preserve the existing webhook configuration |
| TRUST_PROXY / VOICE_TRUSTED_PROXY_IPS | Actual trusted proxy addresses/CIDRs from the ingress deployment, not arbitrary Internet IPs |
| VOICE_TRUST_PROXY_HEADERS | Enable only with the trusted proxy allowlist configured |

Do not treat OpenAI as having a single universal concurrency quota: derive the declared budget from your actual RPM/TPM, model, prompts, retries and measured latency. Confirm Twilio's inbound/ConversationRelay/transfer limits separately. For illustration, 350 calls with one model turn every 10 seconds produce about 2,100 model turns/minute before tool calls or retries. Measure token consumption per turn.

The email path is not a bulk-mail capacity guarantee. At high urgent-alert rates, test the actual Gmail/Workspace sending quota and transport latency. PagerDuty is a separate operations escalation path; it pages your staffed operator, not the customer's business phone. Configure the operator escalation schedule in PagerDuty and verify receipt. The app never marks a business review acknowledged because a paging provider accepted it.

The reference fleet starts with 4 API, 6 voice, 12 SMS, 2 operations, and two of each remaining worker role. Pools are explicitly bounded and the connection calculation includes one surge replica per deployment. CPU/memory requests are starting allocations for measurement. API/SMS HPA is optional and requires an installed external-metrics adapter; voice stays manually sized because long-lived calls require drain testing. Regenerate connection/provider budgets for maximum replica counts.

Render, inspect and validate without changing the cluster:

```bash
SCALE_IMAGE='registry/your-api@sha256:YOUR_APPROVED_DIGEST' \
RELEASE_SHA='YOUR_TESTED_API_COMMIT' \
SCALE_INGRESS_HOST='api-staging.your-domain.com' \
SCALE_TLS_SECRET='callbackiq-tls' \
node deploy/scale/render.mjs
kubectl --context YOUR_STAGING_CONTEXT apply --dry-run=server -f scale-deployment.json
```

Use the same validated image for every process role. The runtime image reads RELEASE_SHA from the generated ConfigMap. Keep the frontend build paired to its recorded commit. Before a deliberate deployment, create/verify indexes against staging with `npm run migrate:required-indexes -- --apply`, then `npm run migrate:required-indexes`.

The ingress preserves path/query/body and routes all voice callback paths and `/ws/voice` to the voice service; API/SMS and Socket.IO go to API. Polling clients use secure cookie affinity. Check actual TLS termination, forwarded headers, cookies, timeouts and signature validation with real requests. Kubernetes graceful termination does not move live calls from a crashed pod. Six replicas at 100 sessions/75 active turns leave nominal headroom after losing one replica; actual calls on a crashed replica can still be lost and must reach the configured recovery flow.

## Size SMS workers from the measured whole-job duration

The initial 12 SMS replicas with 25 lanes each provide 300 processing lanes, not 300 messages per second. At 200 messages/second, a two-second whole-job average needs roughly 400 occupied lanes before headroom; four seconds needs roughly 800. Account for provider calls, database waits, conversation leases and retries in the duration. A fast webhook ACK does not reduce that work.

After measuring, the renderer uses `ceil(target_rps * worst_measured_p95_seconds / (25 * utilization)) + 1` SMS replicas, then requires queue-age and provider-acceptance SLO verification. This formula is a sizing estimate, not a throughput certificate. Override the renderer with `SCALE_REPLICAS_WORKER_SMS`, `SCALE_REPLICAS_API`, or `SCALE_REPLICAS_VOICE`; it recalculates the Mongo allocation and role expectations. Increasing workers without provider quota and database capacity will not fix an overloaded provider.
