# Bounded-memory Jest coverage execution

## Reason
The API test:coverage command previously ran all suites with --runInBand,
retaining Jest test environment memory in one long-lived Node process.
The full suite exhausted both 4 GiB and an increased 8 GiB heap before
coverage could complete.

## Change
* Retain the original jest.coverage.config.cjs without editing it.
* Extend all its settings using jest.coverage.bounded.config.cjs.
* Replace --runInBand with --maxWorkers=1 and add
  workerIdleMemoryLimit='768MB' so idle Jest worker processes are recycled
  after individual suites when they exceed the threshold.
* Keep coverage collection, coverage thresholds, test paths, and every
  downstream release gate unchanged.

## Critical evidence requirements
* Confirm Jest resolves the new config and at least one focused suite passes.
* Rerun npm run release:certify:ci via the isolated certification script on
  the exact new development commit SHA. An OOM, missing coverage artifact,
  threshold failure, or other error means NOT CERTIFIED.
* Inspect runtime and resource pressure, and investigate leaks separately.
* Complete staging SMS/voice/booking/billing tests before main promotion.

## Rollback
Revert the commit containing this test tooling change. No schemas, runtime
modules, API routes, messages, policies, database code, or payments change.
