# Repeat-call handling update

Base: API main 03c15e267f916fe1af237ecde2bbe4ef5b600be0.

## Behavior

- Separate CallSids retain separate call logs and voice sessions. Business-scoped customer identity remains shared.
- A repeat call no longer resets booking fields, appointment links, request memory, handoff state, or the journey key. This applies beyond the 15-minute introduction cooldown. Calling again no longer expires staff ownership; the existing lifecycle worker's configured expiry policy remains separate.
- Ordinary eligible closed SMS conversations reopen without clearing their request. Explicit AI disable and human takeover remain respected. Voice reuses a closed non-archived conversation and gives team-review guidance; it does not force it open or create a conflicting record.
- Normal recovery and voice fallback share the 15-minute atomic introduction claim. Voice fallback uses the same business/CallSid SMS operation key as normal recovery, including retries. Ambiguous sends retain the claim and rely on the central sender's reconciliation protection.
- The first voice turn to claim a conversation owns voice intake until its session becomes terminal. Another overlapping call cannot change the same request, including after the owner ends if that overlapping call was already marked read-only. SMS and the owner voice call continue to use the same conversation lock. Emergency guidance, ending the call, and contact opt-out remain available.
- A genuinely new later call may take ownership after the prior session ends, while retaining the request history. Unrelated jobs are not silently inferred from a new CallSid. Staff can archive a finished conversation to start a separate conversation on subsequent contact.
- Caller admission uses a single atomic rolling-window document per business/caller, keyed by a salted caller hash. The first ten unique calls are admitted at the default limit; the eleventh is rejected. Replayed CallSids retain their decision within the window. Storage is bounded to 2,048 distinct attempts; excess unknown calls fail closed until entries expire. The new counter starts when this version is deployed; old abuse-signal rows are retained but not used as the counter.

## Verification

Run `node scripts/verify-repeat-calls.mjs --unit` for the focused unit suites, production build, and index manifest check. Run `node scripts/verify-repeat-calls.mjs` for those checks plus isolated MongoDB persistence/concurrency tests and existing Twilio idempotency, opt-out, and voice concurrency suites. The verifier does not inherit production database or provider credentials.

During preparation, 217 tests across 21 unit suites passed, the production build passed, and the 334-entry index manifest matched. MongoDB 7.0.24 downloaded but could not start in the execution environment: `open: Operation not permitted` (exit 100). Consequently the new 14-case database suite has NOT been certified. It covers 20-way caller admission, concurrent duplicate retries, tenant/window isolation, shared SMS/voice cooldown, closed conversation reuse, and interleaved voice writes.

No live Twilio calls, production database migrations, deployment, commit, or push were performed. Passing unit tests is not a claim of production or fleet-capacity certification.

## Release steps

1. Apply the checked update and run the full local verifier on a host that supports MongoDB.
2. Run the application's existing release checks.
3. Run `node scripts/migrate-required-indexes.mjs --apply` with the intended deployment database configuration. The additive change is a TTL index on `voicecallerwindows.expiresAt`; the collection's built-in `_id` uniqueness is the atomic admission boundary. No index is dropped.
4. Deploy the API and worker versions together. Exercise repeat missed calls, voice failures, returning closed conversations, opt-out, and overlapping voice/SMS with live test numbers before enabling for customers.
