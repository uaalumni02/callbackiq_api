# Readiness repair rollout

Apply this patch to a review branch. Deploy API and all worker roles first, then the frontend; the API retains the legacy appointment list response for existing clients. No environment values or dependencies change. The new appointment views use bounded keyset pages, and customer confirmation delivery is read from the linked outbox receipt. Approval requests appear in Requests and attention views until a decision, including expired reservations. Generic “resolve” cannot dismiss a pending approval.

## Required database work

Use your normal secret manager or existing `.env` for MONGO_URL; do not put credentials into commands or commit them.

```
npm run verify:index-manifest
npm run migrate:required-indexes             # inspect; nonzero means missing/conflicting indexes
npm run migrate:required-indexes -- --apply  # additive; no index drops
node scripts/repair-approval-confirmations.mjs
node scripts/repair-approval-confirmations.mjs --apply
```

The last command re-arms missing confirmation recovery, including legacy records previously marked reconciled. It does not send messages directly. Maintenance recreates the stable confirmation job for future appointments; visits already started get a distinct owner review rather than a stale text. Existing sent, failed, or uncertain jobs are not reset. Review failed/uncertain jobs using provider evidence before authorizing any resend.

## Backup and restore

`backup:db` now exists. Install MongoDB Database Tools. For this logical, single-database backup, pause **all writers**, including workers, webhook ingress, integrations, and TTL-changing data where exact counts matter. Set `BACKUP_WRITES_PAUSED=true` only once that is true. For uninterrupted production use, choose the managed database's consistent snapshot/PITR process instead.

```
BACKUP_DIR=/secure/backup/location BACKUP_WRITES_PAUSED=true npm run backup:db
```

The private output directory contains a compressed archive and manifest with SHA256, all collection counts and indexes. Keep it encrypted and off-host using your approved backup destination. The backup script does not configure recurring jobs, retention, or remote storage. An archive without manifest is incomplete. Counts cannot detect every same-count mutation; the operational write pause is required.

Restore to an isolated fresh target using `mongorestore --config=/secure/restore.yml --gzip --archive=/secure/backup/location/<backup>/database.archive.gz`. The config file contains only the restore target URI, is mode 0600, and must not point at production. Use `--nsFrom`/`--nsTo` if renaming the database. Do not start application workers or provider sending against the restored copy.

Set `RESTORE_MONGODB_URI` to the target and `RESTORE_MANIFEST` to the backup manifest, then:

```
npm run restore:verify
```

Verification checks the archive checksum, every backed-up collection/count/index, and critical same-business relationships. TTL expiry or pre-existing dangling references require investigation; a failure is not automatically a patch defect. Rehearse startup and tenant reads with outbound providers disabled; record RPO/RTO. This verifier alone is not a disaster recovery certification. MongoDB tool reference: https://www.mongodb.com/docs/database-tools/mongodump/ and https://www.mongodb.com/docs/database-tools/mongorestore/.

## Staging gates before broad launch

1. Run both builds and complete test suites on the CI Node version, including a working MongoDB replica set and browser tests.
2. Kill maintenance/API after the confirmed decision but before enqueue, restart, and verify exactly one stable outbox identity and an honest delivery state. Exercise duplicate webhooks and uncertain sends.
3. Seed over 50 past and future appointments. Navigate all pages, ties in start time, open approvals, expired holds, handled approvals, and tenant boundaries. Verify mobile and keyboard flows.
4. Fail initial and expired approval emails, verify unhealthy health and an operations incident; accept the review and verify recovery. Expire an acknowledged hold and verify escalation reopens if still unattended.
5. Run `perf:mixed-scale`/`perf:mixed-soak` with dedicated staging tenants and providers. Include Requests and paginated Appointments workload (the patched harness includes both). Confirm provider quotas, delivery, queue recovery, and latency. The local transport simulation is not real-provider capacity evidence.
6. Complete the backup/restore rehearsal and rollback drill. Use a limited monitored pilot before unrestricted launch.

Rollback the code using the package installer receipt, rebuild and redeploy API/workers/frontend together. Additive indexes can remain. Code rollback does not undo messages sent or database decisions; do not blindly restore production data or reset delivery identities.
