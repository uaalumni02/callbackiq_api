# Multi-trade rollout

Supported configuration types: plumbing, HVAC, roofing, electrical, restoration,
garage door, locksmith, landscaping, appliance repair, and Other home service.

## Owner setup

1. Confirm the trade under My Business and save it, then reload Services & Areas.
2. Add only relevant suggested drafts. They start inactive, non-bookable and
   requiring team review. Review the name, category, customer wording, exclusions,
   job details, duration and buffers. Activate and save only actual offerings.
3. Existing offerings are not rewritten. The matcher can infer a category from
   a recognized offering name; review any general-category warnings. Narrow
   offerings cannot authorize a different operation or equipment solely because
   both are in the same trade. Explicit exclusions still win.
4. Review Hours & Appointments, same-day notice, staffing, service area and
   Team & Urgent Requests. This update does not change any booking policy,
   turn on automatic booking, or enable a notification provider.
5. Enable appointment requests only for visits your team can fulfill. Inspection
   or assessment visits are not promises of project completion, parts availability,
   a recurring contract, access authorization, insurance approval or dispatch.

## Industry-specific acceptance

- Plumbing: leakage/activity, blockages, connected fixtures, corrections and safety.
- HVAC: equipment, heating/cooling symptoms, fluid identity, refrigerant review,
  dangerous temperature/gas reports, and urgent staff response.
- Roofing: leak/rain context, storm damage, inspection versus repair/replacement,
  structural hazards and weather-dependent project review.
- Electrical: equipment, area affected, repair versus installation, sparking/gas/
  fire preflight, and professional handoff without hazardous repair instructions.
- Restoration: damage type and current activity, assessment visits, urgent damage
  escalation, and staff review of project scope and insurance questions.
- Garage door: door/opener/spring distinctions, door position, no forcing damaged
  doors, trapped-person reports and preserved callback details.
- Locksmith: home/business/vehicle scope, lockout versus rekeying, trapped people,
  staff verification of access authority and no guaranteed dispatch time.
- Landscaping: lawn/tree/irrigation distinctions, one-time versus recurring work,
  tree hazards and staff review of recurring contracts/projects.
- Appliance repair: appliance identity, symptoms, optional brand/model collection,
  fluid identity, fire/gas concerns and staff verification of parts/warranty.
- Other: explicit concrete offerings and owner-configured questions/exclusions;
  selecting Other is never blanket authorization for arbitrary work.

## Verification and live evidence

Run npm run test:multi-trade, the shared regression suites, and both builds.
These tests isolate external providers; passing them is not live certification.
For each trade, exercise SMS and voice using a real configured pilot business:
missed call -> customer intake/correction -> request -> owner action -> customer
notice/delivery -> explicit final outcome. Test failures and staff takeover too.
Do not create dangerous conditions for testing; use clearly identified simulated
customer reports, approved test numbers and an informed supervising owner.

Generate a blank pilot record:
node scripts/verify-multi-trade-pilot.mjs --template > pilot-evidence.json
Validate recorded observations:
node scripts/verify-multi-trade-pilot.mjs pilot-evidence.json
The checker rejects pending/missing observations. It validates completeness,
not authenticity. Keep evidence references free of customer-sensitive data.
Complete this separately for any actual specialty represented by Other.

## Compatibility

No database migration or dependency changes are required. Qualification data is
stored in the existing recovery-intake memory with a version and service key.
Explicitly configured detailFields overrides the suggested job-detail list;
leaving it absent uses contextual defaults. It never disables safety handling.
A service correction invalidates old qualification answers. Changed job details
invalidate availability evidence. Staff can review unclear/unsupported complex
work; AI scheduling cannot bypass unresolved qualification.
