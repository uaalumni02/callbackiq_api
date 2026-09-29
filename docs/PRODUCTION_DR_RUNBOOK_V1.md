# CallBackIQ Disaster-Recovery Rehearsal

A backup is not certified until a restore has been performed successfully into
an isolated non-production database.

## Safety rules

- Never restore a rehearsal dump into the production URI.
- Use a separate Atlas project/cluster or isolated replica-set database.
- Rotate any provider credentials copied into a rehearsal environment.
- Disable outbound Twilio, Stripe, email, OpenAI, and webhook side effects while
  validating restored data.

See [the concrete backup and manifest verification commands](READINESS_REPAIR_ROLLOUT.md#backup-and-restore). `BACKUP_DIR` and a verified write pause are required; `RESTORE_MANIFEST` is required for restore verification.

## Rehearsal

1. Create a fresh production-like backup using the existing command:

   `npm run backup:db`

2. Restore that backup into an isolated restore-test MongoDB target using your
   existing MongoDB restore tooling.

3. Point only the verification shell/process at the restored database.

4. Run:

   `npm run restore:verify`

5. Verify non-zero / expected counts and referential integrity for:

   - users
   - businesses
   - subscriptions
   - trial redemptions
   - leads
   - conversations
   - messages
   - call logs
   - appointments / slot claims
   - provider mappings / Twilio tracking numbers
   - A2P registrations
   - compliance / webhook idempotency state

6. Start one API process against the isolated restore target with outbound
   provider calls disabled. Confirm `/api/health/ready` passes and tenant
   reads work.

7. Record the backup timestamp, restore timestamp, duration, verifier output,
   missing collections, and corrective actions.

## Certification

Production DR is green only when the latest rehearsal:
- restored into an isolated target,
- passed `restore:verify`,
- preserved critical customer/provider mappings,
- demonstrated application startup/readiness,
- and documented the recovery time.

This bundle cannot perform the real rehearsal automatically because it must not
be given or guess production backup/restore credentials.
