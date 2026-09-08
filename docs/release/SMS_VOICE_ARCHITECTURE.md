# CallBackIQ SMS and voice: architecture and release contract

Baseline: API development commit `11dadbcbff2714e7e5fbb82597158133b1648fad`.
Date: September 8, 2026.
Status: implemented hardening with automated regression evidence; live production certification remains a release gate.

## Product contract

Every useful customer message must either advance the request, answer a question using verified information, clarify one genuinely missing fact, or produce a durable and truthful handoff. Customers must not learn a command vocabulary or repeat facts because a price question took priority. A human taking ownership must stop competing automated replies.

The language layer proposes meaning. Application policy authorizes actions. A service description is customer evidence, not proof the business offers the service. A requested time is a preference, not availability or a confirmed appointment. An attempted external operation is not proof of success.

## System outline across ten engineering responsibilities

| Responsibility | Required behavior | Implementation in this update |
|---|---|---|
| 1. Language understanding | Interpret multiple intents and unfamiliar wording; preserve original facts and corrections. | General grammatical extraction, context-aware service references, metered semantic fallback for unfamiliar messages. Noun-only requests do not automatically start intake. |
| 2. Shared conversation state | Both channels use the same intake facts and policy; keep clarification state separate from service identity. | Shared recovery intake persists service detail/source turn, address, date/time and leak triage; new clear information can recover an unclear intake. |
| 3. Question handling | Answer the customer's question before requesting another missing field. | Price plus service capture; off-script input reaches semantic understanding instead of consuming a deterministic failure count. |
| 4. Pricing and catalog scope | Disclose only approved service-specific estimates; never quote internal lead valuation. | Tenant-scoped discussion-enabled catalog lookup requires an unambiguous positive match and explicit disclosure; missing/invalid/ambiguous data yields no quoted price. |
| 5. Scheduling | Verify service area and availability; retain business approval before confirmation. | Existing booking engine remains authoritative. Shared intake only reads availability, records preferences and creates review work. No new booking authority is introduced. |
| 6. Human ownership | Review pending and a human actively replying are different states. | Unclear review does not disable comprehension; final SMS dispatch refreshes ownership, closure, business settings and recipient identity. Existing completed-intake follow-up records/alerts remain in use. |
| 7. SMS delivery | Durable incoming/outgoing state, duplicate protection, consent and truthful ambiguous outcomes. | Terminal suppression survives replay; network errors with an uncertain outcome retain the delivery attempt and block blind resend. Existing opt-out checks remain. |
| 8. Voice interaction | Interruptions must invalidate stale work promptly; short answers need context before fallback. | Interrupt/speech/DTMF invalidation runs before the serialized turn queue; abort signals and active-turn fences suppress obsolete replies and subsequent fenced actions. |
| 9. Distributed execution | A worker that loses its lease must stop performing new effects. | Conversation/job lease renewal failure or expiry invalidates cooperative guards; expired tokens cannot renew or complete a job. Checks protect intake writes and final SMS dispatch. |
| 10. Verification and operations | Verify named behaviors, publish evidence and measure pilot outcomes. | Dedicated `npm run test:sms-voice-release` gate, behavioral transcript tests, real WebSocket interruption tests, ownership race tests and lease-loss injection. |

## Turn processing

1. Authenticate provider input, resolve the business from trusted routing information, deduplicate and persist the inbound event using the existing ingestion paths.
2. Enforce consent, safety and human ownership. Customer text cannot authorize a tool or change system policy.
3. Extract independently useful facts and questions. Use deterministic evidence where strong; invoke the existing metered semantic path when language is unfamiliar. Reply confidence cannot erase independently qualified facts.
4. Merge facts into the current journey. Preserve canonical service unless corrected; retain new descriptive evidence separately. Do not treat a vague request as a complete service description.
5. Choose the next allowed action: answer a verified question, ask a targeted clarification, check availability, request business approval, or create/update review work. Existing booking tools own appointment mutation.
6. Persist the required state and side-effect intent. Recheck lease validity and automation ownership near the action boundary. Dispatch only when still permitted.
7. Record delivered, suppressed, failed or uncertain outcomes. Reconcile uncertain operations instead of assuming a failed response means nothing happened.

## Why the supplied transcript failed

The previous intake skipped messages containing pricing terms. Service extraction did not recognize resealing, so the pricing branch asked for the service again. The low-confidence wrapper then discarded the reply and used generic rejection text. Voice had a similar unknown-intent branch before contextual callback/booking routing. These issues compounded into a review loop.

The regression corpus now includes the exact messages, the `tube` typo, repeated service descriptions, later leaking information, service-plus-price questions, new information after unclear intake, negated overflow, general requests such as `I need help`, and unfamiliar service descriptions passed through semantic qualification.

## Pricing behavior

A price is returned only from the current business's active, discussion-enabled offering with explicit disclosure and an unambiguous positive configured name/keyword match. An unrelated sole catalog entry is insufficient. Estimates include scope/technician-evaluation conditions. A diagnostic fee is distinct from a job estimate. No matching approved price results in an honest limitation followed by the next useful intake question.

Catalog keyword coverage and business configuration still matter. This update does not invent offerings, approve an unsupported job, or create a pricing range for Atlanta Pro Plumbing & Drain.

## Human review and voice limitations

The system can acknowledge durable review work without promising a callback deadline. Pending review does not prove a staff member accepted responsibility. During active staff ownership, autonomous SMS/status replies are suppressed. Completed intake remains in the existing review workflow; new inbound messages remain durable and can create operational review alerts.

Cancellation and lease guards are cooperative. They prevent later fenced actions; they cannot undo an external request already submitted. An underlying dependency that ignores abort can finish in the background. There is also an unavoidable narrow interval between a final ownership read and external provider submission. These limitations must be addressed by truthful outcome reconciliation, not an exactly-once delivery claim.

## Release gates beyond automated regression

- Run the repository-wide CI/coverage ratchets and database-backed persistence/concurrency suites in the normal development environment. Do not lower coverage thresholds to release this change.
- Verify actual signed Twilio SMS webhooks and ConversationRelay HTTPS/WSS configuration in staging using the deployed revision.
- Run live calls with interruption, silence, poor transcription, transfer failure, hangup and voice-to-SMS continuation. Confirm no obsolete reply or unverified promise.
- Exercise STOP/re-entry, delayed/duplicate callbacks, provider timeout after acceptance, database outage and worker restart. Existing tests are useful evidence, not a substitute for deployed routing checks.
- Exercise business approval, competing appointment requests, closed hours, time zones, calendar failure and reconciliation for the business's actual configuration.
- Confirm all required indexes, worker roles, credentials, consent configuration and provider limits through existing release checks.
- Pilot with a defined transcript corpus and review every unsupported claim, unnecessary repeated question, loop, stale staff request and failed/uncertain delivery.

Track request progression, unnecessary repeated-field questions, handoff reasons, recovery after clarification, staff acceptance latency, SMS response latency, voice first-audio/full-turn p50/p95/p99, interruptions, suppressed stale work and uncertain deliveries. Set numeric latency/conversion targets from the actual deployment and pilot; this change does not claim measured production SLOs.

A production-readiness claim should name the revision, tests, environment and live evidence that passed. A subjective “10/10” label is not a release criterion.
