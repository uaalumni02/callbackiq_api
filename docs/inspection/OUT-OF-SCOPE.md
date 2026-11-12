# Additional patterns requiring confirmation

These are not claimed production incidents or closed findings from the supplied
16-finding review. They were logged instead of silently expanding remediation.

- SUSPECTED: a purchase may succeed at Twilio but lose its response before a SID
  is known. The existing purchase call and subsequent SID assignment are separate
  (`src/services/trackingNumberProvisioning.service.js:345–362`). Durable known-SID
  cleanup does not resolve an unknown purchased SID. Confirm using a lost-create-
  response contract and account inventory tagged with an operation identity before
  designing an additional purchase journal/provider reconciliation policy.
- SUSPECTED: the initial-absence subscription creation branch inserts a child
  without atomically checking that its Business still exists
  (`src/services/subscriptionState.service.js:15–24`). Confirm an actual supported
  journey with no initial subscription plus concurrent business deletion. Normal
  registered-business flows already have a Subscription observation. No parent-
  creation migration or provider compensation policy is introduced here.
