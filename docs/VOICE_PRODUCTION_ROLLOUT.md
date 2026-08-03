# CallBackIQ Voice Production Rollout

## Existing controls retained

The current Phase 9 implementation already includes signed ConversationRelay
upgrades, turn timeouts, deterministic fallback persistence, maximum duration
timers and tenant concurrency leases. This overlay extends those controls.

## Required integration points

1. **ConversationRelay setup**
   - Run `evaluateCallerVelocity` before reserving AI capacity.
   - Run `reserveVoiceUsage` immediately after the VoiceSession is created.
   - When either check rejects the session, invoke the existing callback/SMS
     fallback and end the relay cleanly.
   - On close, call `reconcileVoiceUsage` with final duration and provider usage.

2. **OpenAI failure handling**
   - Treat provider WebSocket closure, explicit provider error events, hard-turn
     timeout and repeated dependency errors as one fallback family.
   - Send one caller-facing sentence, persist callback capture, issue fallback
     SMS, alert the business, and close the transport regardless of downstream
     persistence failure.
   - Do not retry indefinitely. One bounded reconnect is the maximum.

3. **Signature rotation**
   - Replace single-token `twilio.validateRequest` calls with
     `validateTwilioRequestWithRotation`.
   - Keep the primary and next token configured only during the rotation window.

4. **Guarded transfer**
   - Dial staff with asynchronous AMD.
   - Do not bridge merely because AMD says `human`.
   - Play a private whisper and require staff to press 1.
   - On machine, no-answer, timeout or no digit, return to callback capture.

5. **Routes**
   - Mount `voiceOperations.routes.js` under `/api/voice-operations`.
   - Ensure the Twilio usage-trigger endpoint uses the same dual-token signature
     middleware as all other Twilio webhooks.

## Suggested environment variables

```env
TWILIO_AUTH_TOKEN_NEXT=
TWILIO_AUTH_TOKEN_PREVIOUS=
TWILIO_API_KEY=
TWILIO_API_SECRET=

DEFAULT_VOICE_MAX_CONCURRENT_CALLS=3
DEFAULT_VOICE_MAX_DURATION_SECONDS=600
VOICE_CAPACITY_FAIL_CLOSED=true
VOICE_ABUSE_HASH_SALT=replace-with-a-long-random-secret
```

## Release gates

- Forced OpenAI timeout produces callback capture, SMS and an owner alert.
- MongoDB failure does not prevent the relay from ending.
- SMS failure does not keep the call open.
- Daily and monthly caps reject new AI work but preserve fallback capture.
- Voicemail never receives the caller as a completed human transfer.
- Both current and next Twilio tokens validate during rotation.
- Usage-trigger callbacks are signature validated and idempotently audited.
