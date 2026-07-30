# Phase 9 Live Twilio Acceptance Matrix

Run this matrix only against a dedicated staging business, Twilio number, database, and test caller. Do not use emergency-service resources or uncontrolled safety language.

## Preconditions

- The API is deployed at a public `https://` origin.
- `/ws/voice` is available at a public `wss://` URL through a proxy that supports WebSocket upgrades.
- Twilio ConversationRelay onboarding is complete for the account.
- The staging Twilio number's voice webhook points to `/api/twilio/voice` using `POST`.
- Twilio signature validation is enabled.
- The business has services, service area, operating hours, scheduling rules, available slots, transfer phone, and SMS capability configured.
- A Twilio-owned number or verified outgoing caller ID is available to originate scripted calls.
- A separate real mobile test phone is available for manual confirmation-SMS delivery evidence.
- Recording remains disabled.

## Automated code gate

```bash
npm run certify:phase9
```

This runs Phase 9 unit tests, the production-orchestration completion suite, and the API build.

## Public endpoint preflight

```bash
PHASE9_PUBLIC_HTTPS_BASE_URL=https://staging-api.example.com \
PHASE9_PUBLIC_WSS_URL=wss://staging-api.example.com/ws/voice \
PHASE9_BUSINESS_NUMBER=+1... \
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
npm run verify:phase9:live
```

The preflight verifies:

1. The public HTTPS voice endpoint responds.
2. An invalid WebSocket signature is rejected.
3. A validly signed malformed setup forces the public WebSocket failure handler, which must send both an apology frame and an end frame.

## Real call runner

```bash
PHASE9_PUBLIC_HTTPS_BASE_URL=https://staging-api.example.com \
PHASE9_PUBLIC_WSS_URL=wss://staging-api.example.com/ws/voice \
PHASE9_BUSINESS_NUMBER=+1... \
PHASE9_TEST_ORIGINATING_NUMBER=+1... \
TWILIO_ACCOUNT_SID=AC... \
TWILIO_AUTH_TOKEN=... \
npm run verify:phase9:live -- --place-calls
```

The originating number must be a Twilio-owned number or verified outgoing caller ID. The runner creates and polls scripted calls for human transfer, controlled safety escalation, and service identification, then writes a timestamped JSON report. Twilio logs, CallBackIQ database records, alerts, appointment records, and a separate real mobile test phone must be used to record the final pass/fail result, including confirmation-SMS delivery.

## Controlled real-call relay failure

Deploy staging temporarily with:

```env
APP_ENV=staging
PHASE9_ENABLE_LIVE_TEST_HOOKS=true
PHASE9_FORCE_RELAY_FAILURE=true
```

Then run:

```bash
npm run verify:phase9:live -- --place-calls --expect-forced-failure
```

Expected behavior:

- ConversationRelay connects and then intentionally fails after setup.
- The caller hears a brief apology rather than silence.
- The relay sends an end frame and closes.
- The configured `voiceFailure` path runs.
- Partial transcript/session context remains available.
- SMS is sent no more than once.
- A high-priority intervention alert exists.

Immediately disable the hook and redeploy. Confirm the readiness endpoint reports `forcedFailureTestModeDisabled: true`.

## Nine completion gates

| Gate | Test | Required evidence |
|---|---|---|
| 1. Answer after hours | Set `afterHours=voice_ai`; call while operating rules report closed. | Greeting heard; VoiceSession active; signed WebSocket accepted. |
| 2. Identify approved service | State one active residential service. | Correct ServiceOffering selected; no unsupported service accepted. |
| 3. Validate service area | Give supported and unsupported ZIP codes in separate calls. | Supported ZIP advances; unsupported ZIP stops automation and hands off. |
| 4. Offer actual times | Request a date with known provider availability. | Spoken slots exactly match provider output and timezone. |
| 5. Book appointment | Select one slot and explicitly confirm. | One confirmed appointment with `source=voice`, `bookedBy=ai`, and no duplicate. |
| 6. SMS confirmation | Complete the booking from a test mobile number. | Exactly one confirmation SMS and logged provider message ID. |
| 7. Transfer to human | Say “Please transfer me to a person.” Test answered and unanswered. | Staff phone rings; answered completes; unanswered produces one SMS and urgent alert. |
| 8. Safety escalation | In a controlled test say “I smell gas and feel dizzy.” | 911/emergency guidance; booking stops; critical safety alert and handoff. |
| 9. Voice failure fallback | Enable the staging failure hook and call. | Apology, end frame, configured staff/SMS path, transcript retained, high-priority alert. |

## Certification rule

Phase 9 is production-certified only after:

- API `npm run certify:phase9` passes.
- Frontend `npm run certify:phase9:frontend` passes.
- All nine live gates above have saved evidence.
- The forced-failure hook is disabled.
- Recording is disabled.
