# CallBackIQ trial-abuse hardening environment

Production defaults are fail-safe for identity gates: if these variables are omitted in `NODE_ENV=production`, email verification, forwarding-phone verification, trial Turnstile, risk scoring, and Twilio provisioning budgets are enabled.

Required for the full production flow:

```bash
TURNSTILE_SECRET_KEY=...
TURNSTILE_EXPECTED_HOSTNAME=app.callbackiq.com
TWILIO_VERIFY_SERVICE_SID=VA...
TRIAL_RISK_HASH_SALT=<random-long-secret>
```

Recommended explicit settings:

```bash
REGISTER_TURNSTILE_REQUIRED=true
TRIAL_TURNSTILE_REQUIRED=true
TRIAL_REQUIRE_EMAIL_VERIFICATION=true
TRIAL_REQUIRE_PHONE_VERIFICATION=true
TRIAL_RISK_SCORING_ENABLED=true
TRIAL_RISK_REVIEW_THRESHOLD=70

EMAIL_VERIFICATION_REQUESTS_PER_HOUR=5
EMAIL_VERIFICATION_SUBMISSIONS_PER_HOUR=20
PHONE_VERIFICATION_STARTS_PER_HOUR=5
PHONE_VERIFICATION_CHECKS_PER_HOUR=10

TWILIO_AUTOMATIC_NUMBER_PROVISIONING_ENABLED=true
TWILIO_PROVISIONING_BUDGET_ENABLED=true
TWILIO_AUTO_PROVISION_MAX_PER_HOUR=8
TWILIO_AUTO_PROVISION_MAX_PER_DAY=20
TWILIO_ORPHAN_MIN_AGE_MS=1800000

TRIAL_VOICE_DAILY_MINUTES=30
TRIAL_VOICE_MONTHLY_MINUTES=300
TRIAL_VOICE_MAX_CONCURRENT_CALLS=2
TRIAL_VOICE_MAX_CALL_DURATION_SECONDS=300

TRIAL_NO_PAYMENT_METHOD_NUMBER_RELEASE_GRACE_HOURS=48
TRIAL_NUMBER_RELEASE_GRACE_DAYS=7
```

Emergency kill switch:

```bash
TWILIO_AUTOMATIC_NUMBER_PROVISIONING_ENABLED=false
```

The kill switch prevents new automatic number purchases without deleting or disabling numbers already assigned to legitimate businesses.

## Inventory reconciliation

Dry run:

```bash
node --env-file=.env scripts/reconcile-twilio-number-inventory.mjs
```

Release only stale Twilio numbers whose friendly name begins with `CallBackIQ -` and that are not represented by a Business record:

```bash
node --env-file=.env scripts/reconcile-twilio-number-inventory.mjs --release-orphans
```

Run the dry-run audit on a schedule in production. Keep `--release-orphans` as an explicit administrative action until you are comfortable with the inventory report.
