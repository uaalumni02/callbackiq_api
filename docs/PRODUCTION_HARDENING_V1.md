# CallBackIQ Production Hardening v1

This bundle implements the production-readiness recommendations without changing
the product architecture.

## Implemented

- Canonical MongoDB and public API configuration with backward-compatible aliases.
- Fail-closed environment validation before the HTTP server connects to MongoDB.
- Configurable Express `trust proxy`.
- Production/staging CORS no longer automatically trusts localhost.
- Distributed A2P reconciliation lease with heartbeat.
- SHA-256 password-reset-token storage and lookup. Existing reset links issued
  before deployment are intentionally invalidated.
- Transaction-backed registration across User, Business, initial Subscription,
  Business setup update, and trial-eligibility read.
- Fresh database role lookup for cross-tenant conversation admin bypasses.
- Production browser auth keeps the JWT in the HttpOnly cookie and does not
  return the same token in response JSON. Development/test behavior remains
  compatible.
- Mongo-backed distributed public-auth IP rate limits in production/staging.
- Cursor pagination (default 100, hard max 200) for leads, conversations, and
  conversation messages. The response body remains the same array shape; paging
  metadata is returned as `X-Page-Limit`, `X-Has-More`, and `X-Next-Cursor`.
- Separate worker entrypoint and process roles.
- Multi-instance realtime startup guard requiring Redis.
- Controlled production index migration (creates only; never `syncIndexes()`).
- Runtime HTTP p50/p95/p99 structured logging hooks.
- Operational queue/A2P metrics snapshot command.
- HTTP performance-budget command.
- Release gate and certification command.
- Structural hardening regression tests plus Jest unit coverage for the new runtime/security services.
- Disaster-recovery rehearsal runbook.

## Process topology

Recommended production topology:

- Web: `PROCESS_ROLE=api` + `node build/server.js`
- SMS: `PROCESS_ROLE=worker-sms` + `node build/worker.js`
- Automation/lifecycle: `PROCESS_ROLE=worker-automation` + `node build/worker.js`
- A2P: `PROCESS_ROLE=worker-a2p` + `node build/worker.js`
- Maintenance: `PROCESS_ROLE=worker-maintenance` + `node build/worker.js`

`PROCESS_ROLE=all` remains the backward-compatible default for local/single
instance operation.

## Cursor pagination

Existing clients continue receiving `data: [...]` with at most 100 records.
To get the next page, send the returned `X-Next-Cursor` as `?cursor=...`.
Use `?limit=N` to request 1-200 records.

The UI should eventually add "load more" / infinite scroll so records beyond
the first page remain discoverable.

## Release sequence

1. Set production environment variables.
2. `npm run release:gate`
3. `npm run migrate:indexes -- --dry-run`
4. `npm run migrate:indexes`
5. `npm run test:production-hardening-v1`
6. `npm run test:ci`
7. `npm run build`
8. Deploy.
9. Check `/api/health/live` and `/api/health/ready`.
10. Run `npm run perf:http:budget` against an authorized deployment.
11. Run your existing Twilio/Stripe smoke and real missed-call end-to-end flow.
12. Run `npm run metrics:snapshot` and verify expected queue/provider state.

`npm run release:certify` combines the local release gates but does not replace
real provider smoke tests or a disaster-recovery rehearsal.

## Important deployment notes

- MongoDB transactions require a replica set / Atlas deployment.
- Existing password-reset links become invalid because only hashed reset tokens
  are accepted after this patch.
- If production has more than one HTTP instance, set `API_INSTANCE_COUNT` and
  provide `SOCKET_REDIS_URL`/`REDIS_URL`.
- Do not set `AUTH_RESPONSE_TOKEN_ENABLED=true` in production.
- `migrate:indexes` creates required indexes but deliberately does not drop old
  indexes.
