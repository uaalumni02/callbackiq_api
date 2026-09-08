# SMS / Voice implementation evidence

September 8, 2026. Baseline: `11dadbcbff2714e7e5fbb82597158133b1648fad` on development.

## Completed checks

| Check | Result |
|---|---|
| `npm run test:sms-voice-release` | 640 tests passed; 33 suites passed; zero failures |
| `npm run test:hardening` | 59 checks passed; zero failures |
| `npm run build` | 400 ES modules built for Node 20+ |
| `npm run audit:repository-hygiene` | Clean; no findings |
| `git diff --check` | Clean |

The SMS/voice gate includes actual reply-pipeline tests with documents saved and reloaded between messages, the exact bathtub transcript, an unfamiliar service routed through metered qualification, shared SMS/voice intake, approved pricing boundaries, booking-permission regressions, handoff ordering, consent/ownership suppression, uncertain delivery, conversation/job lease loss, and real WebSocket interruption tests with a deferred dependency.

Provider/DB dependencies in the focused conversational tests are mocked or isolated. No production customer SMS, phone calls, paid AI calls or new Twilio numbers were used. These tests do not measure live provider quality or production latency.

## Existing test corrections

The previous static voice source checks expected four unmatched turns even though baseline implementation already used two. The static hardening assertion now matches two; voice behavior is verified by actual bounded-turn tests. Malformed voice-model tests now assert that untrusted model fields are discarded while independent deterministic evidence survives. Pricing-copy assertions were updated to the new replies while retaining checks against unsupported commitments.

## Incomplete broader checks

An attempted repository-wide `npm test` run did not complete and emitted `fatal library error, lookup self`; the incomplete process was stopped. That run also observed a temporary pricing-reference error during integration edits; the corrected final pricing path passed the dedicated gate. It is not a passing repository-wide CI result. Full coverage, coverage ratchets, replica-set/persistence certification, live Twilio and deployed pilot acceptance must still pass in the normal environment before release.

No GitHub branch was pushed or merged, and no deployment was performed. See `SMS_VOICE_ARCHITECTURE.md` for the operating contract and remaining release gates.
