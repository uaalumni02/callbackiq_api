# Shared SMS and voice request qualification

Implemented against API commit 26ea9cd4f3cfdb002e5a61444a9db11305c2a1e7.

## Behavior

- The same shared intake assesses vague problems for plumbing, HVAC, electrical, roofing, restoration, garage door, locksmith, and landscaping.
- Problem clarity is distinct from supported service, operational urgency, geographic coverage, calendar availability, and human approval. Existing safety/STOP/takeover precedence remains authoritative.
- Explicit work requests continue without unnecessary diagnostic questioning. Vague malfunctions receive a short domain question. Two distinct unhelpful answers, or an explicit inability to describe the issue, route to staff. Address/time answers and side questions do not spend the clarification budget. The full conversation remains the source for detailed customer evidence.
- Coverage is checked as soon as a saved address has a ZIP. Known unsupported addresses stop appointment options. Missing configuration, incomplete configuration, and lookup failures require staff review. The shared evaluator serves owner eligibility checks and live scheduling.
- Missing readiness no longer completes manual intake. Persisted readiness separates staff review, appointment options, and eligibility to proceed with approval; it never confirms an appointment.
- Availability evidence includes a request fingerprint and timestamp. Completion wording needs current verified evidence (five-minute maximum); changed facts and unresolved blockers invalidate that claim. Appointment creation/confirmation still recheck current availability.
- Calendar and appointment tools recheck problem clarity and unresolved leak/clog triage against the saved request, independently of model arguments. Staff-reviewed appointment operations retain the existing explicit approval path.
- Review metadata contains the problem evidence, coverage outcome/reason, readiness blockers, requested timing, and triage. Existing durable alerts, notification jobs, acknowledgment, and overdue processing are retained. No message is sent by the audit script.
- Voice uses the shared intake, persists qualification, and awaits durable review-alert creation before returning its review outcome. A failed write propagates; it cannot become a successful acknowledgment.

## Configuration and compatibility

There is no database rewrite or automatic coverage migration. Existing explicit ZIP lists and valid radius settings keep working. Businesses that relied on missing/empty coverage being permissive now require configuration or manual review. That is intentional.

ServiceArea.type accepts `zip_codes`, `radius`, or explicit `unrestricted`. Configure ZIPs/radius in the existing owner settings, or explicitly save `{"type":"unrestricted"}` through the existing service-area API if that truly represents the business. Do not automatically choose unrestricted to silence an audit warning. ZIP-radius decisions use the existing postal-distance provider; lack of distance evidence is unknown, not accepted coverage.

An offering optionally accepts:

```json
{
  "intakePolicy": {
    "requireClarification": true,
    "clarificationQuestion": "Which component needs attention?",
    "detailKeywords": ["drive belt", "motor"]
  }
}
```

The default domain questions work without new configuration. The optional policy allows clarification for otherwise nonspecific catalog requests and recognizes owner-provided detail vocabulary. It does not diagnose equipment, authorize service, suppress safety rules, or grant booking permission.

The existing owner-scoped, version-checked intake approval remains the explicit staff decision. If a staff member approves a diagnostic visit while details remain unclear, the exact unresolved problem/triage and approving actor are retained in the review audit and appointment notes. The system does not falsely mark the customer problem resolved. An optional string `qualificationReviewNote` (15–500 characters, when supplied) can document the decision. Existing owner UI approval payloads continue to work; no new frontend field is mandatory. Automated scheduling tools cannot use this human-review exception. Coverage and calendar checks still apply to staff approvals.

Owner eligibility preview now uses the same service notice overrides/default 24-hour notice and geographic evaluator as scheduling. Geographic reason codes align with the scheduling policy (`matched`, `outside_configured_service_area`, etc.). Unknown coverage produces `SERVICE_AREA_REVIEW_REQUIRED` at the availability boundary, before provider access, rather than an empty or fictitiously available calendar.

## Read-only deployment check

Run from the API repository with the intended environment configured:

```bash
node scripts/audit-request-qualification.mjs --business-id BUSINESS_OBJECT_ID
```

Add `--postal-code 35022` to check a sample location. A radius sample may call the existing postal-distance provider. The audit prints coverage readiness, whether email notifications are enabled in this process, verified owner-recipient availability, recent worker heartbeat evidence, and notification-job status counts. It does not expose email addresses or connection strings. Exit 2 means review the reported issues, exit 1 means the audit could not complete.

Heartbeat evidence is available only where the existing fleet heartbeat is enabled. An absent heartbeat is a verification gap, not proof the worker is down. Verify settings in the deployed worker environment rather than assuming local environment variables reflect production. Provider acceptance is not proof of delivery or human acknowledgment.

## Verification and release limitations

Automated checks performed here:

- All 278 unit suites plus service policy, real-channel service journeys, booking-eligibility coverage, and the booking conversation integration matrix: 282 suites, 3,246 tests passed.
- Subsequent handoff wording regression: 4 suites, 139 tests passed (overlapping tests; do not add these totals).
- Subsequent approval compatibility/policy regression: 4 suites, 120 tests passed (also overlapping).
- Production build succeeds for Node 20+.
- Cross-trade tests exercise actual SMS reply and voice-agent entry points with database/model/provider boundaries simulated. Shared-intake tests cover both channels; reload tests reconstruct saved records between turns.

Mongo-backed booking eligibility was attempted, but MongoDB exited at startup with `open: Operation not permitted`. Mongo persistence, replica-set concurrency, real Twilio calls/messages, calendar access, and real staff delivery/acknowledgment were not certified here. No production customer messages were sent. No production deployment or GitHub push was performed.

Before release, run the complete local/CI suite (including Mongo and replica-set gates), then stage both channels with configured tenants and actual providers. Verify a request all the way from inbound contact through persisted review, notification, human acknowledgment/approval, and customer confirmation. Include: missing/outside/radius coverage, service/address corrections, unclear answers, active safety escalation, compound pricing/availability messages, expired options, duplicate webhooks, failed sends, concurrent approval, SMS/voice overlap, and staff nonresponse. Confirm no appointment changes without explicit approval.
