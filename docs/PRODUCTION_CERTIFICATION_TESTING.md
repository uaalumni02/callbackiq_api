# CallBackIQ Production Certification Testing

## Purpose

This layer turns the existing CallBackIQ regression suites into a repeatable
release gate for the customer journey:

registration → verification → trial → telecom readiness → missed-call recovery
→ AI qualification/pricing → scheduling → owner approval → confirmation →
calendar/reminders → reschedule/cancel → billing.

It intentionally reuses the repository's real route/service/orchestration
tests instead of creating a second fake implementation of CallBackIQ.

## Safety invariant

Normal Jest and CI certification must never create live external resources.

The installer adds a global Jest provider-network guard that blocks:

- `*.twilio.com`
- `*.stripe.com`
- `*.openai.com`
- `*.googleapis.com`
- Google OAuth endpoints
- `*.resend.com`
- Gmail SMTP

The certification runners also replace inherited provider credentials with
inert test values before starting Jest.

As a result, a future test that accidentally forgets to mock Twilio will fail
with `EXTERNAL_PROVIDER_NETWORK_BLOCKED` instead of buying a number, attaching
a sender, sending an SMS, or making another live provider call.

## Commands

Run the deterministic customer-journey + provider certification:

```bash
npm run test:production-certification
```

Run provider contracts only:

```bash
npm run test:provider-contracts
```

Run only the network-safety tests:

```bash
npm run test:provider-safety
```

The installer also inserts production certification into `npm run test:ci`.

## What normal CI does NOT do

Normal CI does not:

- purchase Twilio numbers
- submit A2P registration
- attach live Messaging Service senders
- send live SMS
- create live Stripe subscriptions/charges
- call live OpenAI
- create/update/delete Google Calendar events
- execute staging mutations

## Read-only staging smoke test

Staging is separate because it is an environment check, not a deterministic
unit/integration test.

It uses an already-provisioned staging business and performs GET/HEAD requests
only.

Example:

```bash
export STAGING_API_BASE_URL="https://your-staging-api.example.com"
export STAGING_TEST_BEARER_TOKEN="YOUR_STAGING_TEST_TOKEN"
export STAGING_CONFIRM_PREPROVISIONED_RESOURCES="yes"

npm run smoke:staging:safe
```

Optional route overrides:

```bash
export STAGING_HEALTH_PATH="/health"
export STAGING_TWILIO_WEBHOOK_PATH="/api/twilio/sms"
export STAGING_BUSINESS_STATUS_PATH="/api/business/mine"
export STAGING_APPOINTMENTS_PATH="/api/appointments"
```

The staging smoke script rejects any method other than GET or HEAD.

## Certification stages

The manifest lives at:

`tests/e2e/productionJourney.manifest.js`

Each lifecycle stage maps to existing CallBackIQ regression suites. If a suite
is intentionally renamed or replaced, update the manifest in the same commit.

The structural certification test verifies that every referenced suite exists
and that CI continues to install the global external-provider guard.

## Manual testing still matters

Automated certification is the regression gate. Manual testing remains the
right place to validate UX and a small number of deliberate real-provider
flows in a controlled staging account.
