# CallBackIQ real-world pilot acceptance gate

This gate is intentionally separate from deterministic CI. A release is **not real-world certified** until these checks are performed against the production-like deployment with a real mobile phone and real provider integrations.

## Required journey

1. Record the exact API and frontend commit SHAs being tested.
2. From a phone that is not the business phone, call the provisioned CallBackIQ number.
3. Exercise the configured Voice AI / overflow / missed-call route and verify a durable CallLog/lead/conversation appears.
4. Verify the recovery SMS is actually delivered to the handset and the provider SID/status is stored.
5. Reply with service, urgency, address and preferred timing; verify qualification persists without re-asking known facts.
6. Send an urgent plumbing scenario. Verify safe guidance, no guaranteed callback/arrival promise, a high/critical operational alert, and continued assistance unless a human explicitly takes over.
7. Request an appointment. Verify only real configured availability is offered and closed hours are never offered.
8. Verify an approval-required AI request is labeled requested/held, not booked. Approve it; verify final availability recheck, customer confirmation, calendar event, attribution linkage and reminder state.
9. Reschedule and cancel in separate runs and verify customer/calendar state remains consistent.
10. Ask for a human. Verify the acknowledgement does not guarantee a callback time, the conversation enters handoff state, and AI does not resume after staff takeover.
11. Verify Stripe `/billing/access` state for trialing/active and one blocked/expired state.
12. Start the API with `PROCESS_ROLE=api` and the worker with `PROCESS_ROLE=worker`; confirm worker logs include `Started voice-usage worker` and API `/api/health/ready` returns 200.
13. Cause a safe test operational exception and prove it appears in Needs Attention/alerts.
14. Perform the DR rehearsal from `docs/PRODUCTION_DR_RUNBOOK_V1.md` against an isolated restore target and run `npm run restore:verify`.

## Evidence

Copy `docs/pilot-acceptance.example.json` to `docs/pilot-acceptance.evidence.json`. For every stage set `passed: true`, add the observation timestamp, and record a provider SID, event ID, screenshot filename, log correlation/request ID, calendar event ID, Stripe object ID, or restore report reference.

Then run:

```bash
npm run verify:pilot-evidence
```

Do not commit customer PII, secrets, access tokens, recordings, or full SMS contents into the evidence file. Use redacted identifiers.
