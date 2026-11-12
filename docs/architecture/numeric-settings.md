# Numeric settings

All registered numeric settings use `numericSetting(name, environment)` and are
validated by `validateEnvironment` before the server or worker starts. Missing,
null, empty and whitespace-only values are absent and use the declared default.
Only an explicit numeric zero can invoke a zero policy. Invalid nonnumeric,
nonintegral or unsafe values fail startup. Worker settings retain their bounds.
Do not use `Number(env.X)` in a consumer of a registered setting.

| Setting | Default | Bounds | Explicit zero |
|---|---:|---|---|
| TRIAL_MAX_ADMIN_EXTENSION_DAYS | 14 days | 0 through maximum safe integer | Unlimited lifetime admin extensions; each grant still has the existing 14-day limit |
| AI_ANALYSIS_HISTORY_LIMIT | 200 messages | Clamp 20–500 | Use default 200 |
| WEBHOOK_WORK_CONCURRENCY | 5 jobs | 1–25 | Rejected |
| WORKER_DRAIN_TIMEOUT_MS | 120000 ms | 1–600000 | Rejected |
| TRIAL_LIFECYCLE_INTERVAL_MS | 3600000 ms | 1–86400000 | Rejected |
| BILLING_INTEGRITY_INTERVAL_MS | 86400000 ms | 1–604800000 | Rejected |

The worker compatibility adapter delegates to this parser. Trial reservation
reads the configured allowance before touching the reservation counter or
calling Stripe. A blank deployment value cannot remove the lifetime cap.

Scope: other legacy numeric environment consumers still need an audited
registry entry before this configuration finding can be considered fully closed.
This document does not certify their zero semantics.
