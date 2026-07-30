# Phase 9 Voice AI and SMS Routing Policy

## Business-level routing fields

`Business.voiceSettings.routingPolicyVersion` is set to `1` after the business saves the new policy.

```js
routingPolicy: {
  openHours: "voice_ai" | "sms" | "staff_then_voice_ai" | "staff_then_sms",
  afterHours: "voice_ai" | "sms" | "staff_then_voice_ai" | "staff_then_sms",
  voiceFailure: "sms" | "staff_then_sms"
}
```

The existing `answerMode` remains as a preset and compatibility field:

- `disabled`
- `after_hours`
- `overflow`
- `always`
- `custom`

Existing business records have `routingPolicyVersion: 0`. They retain the exact legacy `answerMode` behavior until the owner saves the new settings. This prevents Mongoose defaults from silently changing live routing.

## Routing behavior

### `voice_ai`

The call enters Twilio ConversationRelay immediately. If ConversationRelay is not configured, the independent `voiceFailure` policy is used.

### `sms`

The call receives a brief spoken acknowledgment, ends cleanly, and queues the existing idempotent missed-call SMS recovery path. SMS opt-out and feature controls are still enforced.

### `staff_then_voice_ai`

The configured staff number rings for `overflowRingSeconds`. If answered, the call completes with staff. If unanswered, busy, failed, or canceled, the call enters ConversationRelay.

### `staff_then_sms`

The configured staff number rings first. If unanswered, the call receives a brief spoken apology, ends cleanly, and queues missed-call SMS recovery.

### Voice failure

- `sms`: end ConversationRelay and run the idempotent SMS/alert recovery path.
- `staff_then_sms`: end ConversationRelay, attempt staff transfer, then send SMS and create an urgent alert if unanswered.

## Recording policy

Call recording is intentionally disabled. The API rejects `recordingEnabled: true`, TwiML never requests recording, the frontend does not expose a recording toggle, and the migration command clears legacy true values.

Recording should not be activated until CallBackIQ has approved disclosure, consent, access, retention, export, deletion, and incident-review requirements.

## Staging forced-failure hook

The relay server contains a staging-only failure hook for live acceptance testing:

```env
APP_ENV=staging
PHASE9_ENABLE_LIVE_TEST_HOOKS=true
PHASE9_FORCE_RELAY_FAILURE=true
```

The hook is blocked when `APP_ENV` or `NODE_ENV` resolves to `production`. Readiness reports fail while the hook is active. Remove both variables or set them to `false` immediately after the controlled test.
