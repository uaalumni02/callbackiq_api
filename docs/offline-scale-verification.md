# Offline scale verification

This update repairs the database-free transport harness and makes local voice turn admission FIFO. It does not change the default session or AI concurrency limits, and does not certify production capacity.

## Runtime change

Waiting turns enter a bounded FIFO queue. A slot release wakes waiting work immediately instead of making each caller compete on a 25 ms polling timer. Expired and canceled turns cannot start later. An acquired local turn reservation remains occupied while obtaining fleet capacity; fleet exhaustion still retries within the existing queue deadline. Redis failure still fails closed. Existing sessions can finish while connection admission drains.

Local FIFO ordering is not a distributed FIFO promise across replicas. Redis retains the fleet ceiling. Admission snapshots include completed/failed counters, cumulative queue/processing milliseconds and maximum queue wait; no customer text is collected. The optional per-turn timing callback cannot change the result.

## Commands

From the API repository with dependencies installed:

```
node scripts/run-offline-scale.mjs
node scripts/run-offline-scale.mjs --soak
node scripts/run-offline-scale.mjs --soak --persistence
```

The runner passes an allowlisted environment and an empty dotenv file to children. It does not inherit production database/Redis URLs or provider credentials. The default command runs deterministic regressions and a 1,001-session, 350-concurrent transport simulation. `--soak` increases this to 50 turns per client; it is a sustained synthetic workload, not a 60-minute live soak. `--persistence` first starts a new local MongoDB replica set, then runs database-backed voice, SMS recovery, owner-read and tenant-isolation suites. Each suite owns its test data; no externally supplied database URL is accepted by this runner. Startup failure exits nonzero and is not a skipped/pass result.

The new GitHub Actions workflow runs the sustained and persistence checks on Ubuntu for main/development pushes and pull requests, and supports manual dispatch. MongoDB binaries may need downloading on the first run. Provider access is blocked in the tests. This workflow has been supplied, not executed remotely as part of this delivery.

## Transport controls

`VOICE_TRANSPORT_CLIENTS`, `VOICE_TRANSPORT_BUSINESSES`, `VOICE_TRANSPORT_CONCURRENCY`, `VOICE_TRANSPORT_TURNS`, `VOICE_TRANSPORT_AGENT_DELAY_MS`, `VOICE_TRANSPORT_AI_LIMIT`, `VOICE_TRANSPORT_SESSION_LIMIT`, `VOICE_TRANSPORT_TIMEOUT_MS`, `VOICE_TRANSPORT_HOLD_MS`, `VOICE_TRANSPORT_REPORT_PATH` configure direct harness runs. Defaults are 1001 clients/businesses, 350 concurrent sessions, 4 turns, 100 ms simulated AI and 50 processing slots. These are fixture limits, not production environment changes.

The harness checks session business identity and exact response identity, counts completed turns, separates queue delay from mock processing, and waits for socket cleanup. Rejected handshakes and timed-out turns close their sockets and produce nonzero status. It explicitly mocks signatures, business admission, MongoDB/session persistence, conversation locking, Redis fleet capacity, provider calls and AI reasoning. It exercises the production WebSocket server and local admission queue. It does not test persisted tenant isolation, SMS webhooks or authenticated dashboard traffic.

## Deployment declarations

```
node scripts/verify-voice-topology.mjs scale-deployment.json
node scripts/verify-scale-deployment.mjs
```

The topology verifier checks the generated Kubernetes JSON's actual replica counts against declared counts, N-1 session/turn capacity, provider fleet ceilings, role separation, common configuration references, per-pod overrides, voice service routing, WebSocket ingress path/timeout and termination grace. The renderer runs it before writing a deployment file. Existing capacity-plan quota, SMS sizing and Mongo connection-budget checks remain required. The environment verifier now also runs the scale-profile checks when configured and flags conflicting declared Redis endpoints.

This validates configuration text only. Shared secret values, real load distribution, host shutdown behavior, usable MongoDB connections and provider quotas require infrastructure verification. No secret or deployment setting is changed automatically. The default instance limit remains 100 sessions.

## Remaining acceptance

Use the existing `perf/mixed-scale.mjs`, `perf/mixed-soak.mjs` and evidence verifier on authorized staging for 1001 authenticated businesses, 350 sustained voice sessions, 200 SMS webhooks/second and owner reads together. The deterministic persistence suites are not a substitute for that combined workload. Live provider latency/quotas, fault recovery, and continuous soak evidence remain required. A local Mongo startup error is an environment blocker; it must not be counted as a successful database test.
