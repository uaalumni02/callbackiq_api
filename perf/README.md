# CallBackIQ performance harnesses

These are manual load/performance tools. They are intentionally **not** part of
normal CI and default to loopback-only targets.

## Webhook burst

Start the API locally, then:

```bash
npm run perf:webhook
```

Defaults:
- target: `http://127.0.0.1:3000/api/twilio/sms`
- requests: 50
- concurrency: 50 (a true 50-request burst by default)
- timeout: 10 seconds/request

Useful variables:

```bash
PERF_TARGET_URL=http://127.0.0.1:3000/api/twilio/sms \
PERF_REQUESTS=100 \
PERF_CONCURRENCY=20 \
PERF_HEADERS_JSON='{"x-test-signature":"..."}' \
npm run perf:webhook
```

The script reports throughput plus p50/p95/p99/max latency.

For a signature-protected Twilio route, either point the harness at a dedicated
local test instance configured for your normal test signature strategy or supply
the headers/payload needed by that local environment. Do not disable signature
validation in production code for performance testing.

## Socket.IO fan-out baseline

The Socket.IO harness is self-contained and local-only. It starts an ephemeral
Socket.IO server, initializes CallBackIQ's **real `SocketService`**, connects N
clients into one business room, then measures delivery latency across repeated
fan-out rounds. The authenticated two-tenant behavior is covered separately by
the integration suite.

```bash
PERF_SOCKET_CLIENTS=50 \
PERF_SOCKET_ROUNDS=10 \
npm run perf:socket
```

It reports connection p50/p95/p99 plus per-delivery and full-round fan-out
p50/p95/p99. No application port, token, Twilio account, or remote service is
needed.

## Remote targets

The harnesses refuse non-loopback hosts by default. For an environment you own
and are explicitly authorized to load-test:

```bash
ALLOW_REMOTE_LOAD_TEST=true ...
```

Start small. Never aim these tools at third-party services (including Twilio or
Stripe) or environments you do not control.
