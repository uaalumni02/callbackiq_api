# CallBackIQ Voice Concurrency Certification

This suite makes simultaneous-call correctness a release gate without placing PSTN calls in ordinary CI.

## What it proves

The deterministic Mongo-backed tests verify:

- 2, 10, and 20 different callers to one business remain isolated.
- each different caller receives a distinct VoiceSession, provider session, Lead, Conversation, CallLog, transcript, and capacity lease.
- `maxConcurrentCalls=2` admits exactly two of three simultaneous sessions and leaves the admitted sessions untouched.
- two first-time calls from the same caller share customer identity records where appropriate but retain separate VoiceSessions, CallLogs, provider session IDs, transcripts, terminal state, and call state.
- ending one call releases only that call's capacity lease.
- expired crash-orphan leases are reclaimed while a live lease remains intact.
- two simultaneous handoff requests preserve their own VoiceSession, Conversation message, transfer reason, alert, and downstream transfer result.
- repeated concurrent delivery of the same Twilio CallSid remains idempotent.

The same-caller test also protects a production race fix in `VoiceSessionService.ensureContext()`: if two first-time calls both attempt to create the caller's unique Lead or active Conversation, the losing insert now re-fetches the record created by the winning call instead of failing the second call.

## CI gate

Run:

```bash
npm run test:voice-concurrency
```

The installer also appends this test to the existing `test:ci` script, so `release:certify` inherits the deterministic concurrency gate through the existing CI chain.

## Full synthetic load certification

Use the repository's existing dedicated voice-load database/environment. Start the API separately with `.env.voice-load`, then run:

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_LOAD_ALLOW_DB_WRITES=true \
npm run certify:voice-concurrency:load
```

The load certificate orchestrates the existing production-shaped harnesses:

1. deterministic correctness suite;
2. 50 atomic Mongo capacity acquisitions against the configured limit;
3. 100 signed `/api/twilio/voice` webhook requests at concurrency 20;
4. 10 simultaneous ConversationRelay sessions;
5. 20 simultaneous ConversationRelay sessions;
6. 50 relay attempts with the configured capacity ceiling (normally 25 accepted).

Do not run DB-writing load mode against production.

## Real Voice AI concurrency

This can consume OpenAI tokens and is intentionally opt-in:

```bash
DOTENV_CONFIG_PATH=.env.voice-load \
VOICE_LOAD_ALLOW_DB_WRITES=true \
VOICE_LOAD_ALLOW_AI=true \
npm run certify:voice-concurrency:ai
```

The AI mode adds 10 simultaneous real Voice AI sessions with two turns per session after all deterministic and synthetic load gates pass.

## Zero-tolerance correctness invariants

A release fails for any of the following:

```text
crossTranscriptContamination > 0
incorrectLeaseReleases > 0
duplicateCallSidSessions > 0
orphanedLiveLeases > 0
unexpectedSessionTermination > 0
```

Latency is important, but session isolation is the higher-priority safety property.

## Downstream business-phone transfer smoke test

Synthetic testing can prove CallBackIQ and Twilio-side session isolation, but it cannot prove that a customer's downstream carrier, handset, PBX, or call-waiting configuration accepts two transferred calls simultaneously.

Before broad production rollout, perform a small staging/live test with two calls transferring to the business's real destination and record whether the destination provides call waiting, second-line ringing, busy, voicemail, or PBX queueing. Keep this outside ordinary CI.

## Report

`npm run certify:voice-concurrency`, `:load`, and `:ai` write a JSON summary such as:

```text
voice-concurrency-certification-2026-08-26T22-00-00.000Z.json
```

Override with `VOICE_CONCURRENCY_REPORT_PATH` when a fixed artifact path is preferred.
