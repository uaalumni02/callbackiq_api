# Security and maintainability maintenance

Scope: API baseline 55362b127cc4a72453ca96e995fe54bea95c1333 and frontend baseline 025e4b190a3ceea2f9ece92c0ac4f3361dc230d3. These are explicit behavior corrections, not a zero-functional-change refactor. Neither source repository is promoted or deployed by the downloadable installer.

## Authentication

New registration and reset use 15–128 Unicode code points, permit spaces/symbols, reject controls and a small local common-password/repetition list. This local list is not a comprehensive breached-password database. Existing hashes remain readable. New hashes use a versioned SHA-256 prehash followed by bcrypt, avoiding 72-byte truncation. NFC normalization applies only to new-format hashes; legacy comparison remains byte-compatible.

Reset consumption atomically matches the user, hash and expiry while changing the password, clearing the token and incrementing sessionVersion. Reading a token no longer grants permission to update later.

Administrator password login returns a five-minute, opaque challenge without establishing an authenticated session. First use enrolls an authenticator; subsequent logins require a fresh TOTP or one recovery code. TOTP verification uses OTPAuth (RFC 6238), a 30-second period and one-step clock tolerance. Used TOTP steps cannot be replayed. Enrollment, challenge consumption and recovery-code consumption use MongoDB transactions and atomic predicates. Five failures exhaust a challenge; account-level issuance and attempt budgets apply across clients. Password reset does not remove MFA.

Ten random 128-bit recovery codes are displayed once and stored as hashes. Recovery rotation requires the current password and a fresh TOTP, invalidates old codes, and revokes other sessions. There is no email-only MFA bypass. Loss of both authenticator and recovery codes requires an independently verified administrative recovery procedure; do not clear MFA based only on an email request.

Old administrator JWTs lacking verified MFA are rejected. Admin sessions last at most eight hours; privileged writes require authentication within fifteen minutes. Signing in again supplies that recent authentication. Database roles remain authoritative. Socket admission follows the same policy and caps the socket's expiry. Owner logins continue to accept existing passwords; stronger requirements apply to newly selected passwords.

### Deployment prerequisite

Configure and securely back up a stable INTEGRATION_ENCRYPTION_KEY (at least 32 characters) before deploying. MFA secrets reuse the existing authenticated encryption service. Changing this key without migration loses access to both encrypted integration credentials and MFA secrets. Never paste it into chat or commit it. No key is generated or placed in this package. The MongoDB deployment must support transactions, as already required by other application workflows.

## State ownership and recovery

Rescheduling durably claims the original appointment before calling the provider. Different keys cannot own the same pending original. Same-key replay is checked against the original request fingerprint. The original is not overwritten after a newer cancellation. A superseded provider move creates durable compensation evidence; failed cleanup retains its slot protection and is retried by appointment maintenance. Successful cleanup releases the slot. Reconciliation remains idempotent.

Appointment document saves require their observed tenant, status, private state version and timestamp. Conversation and lead saves require their observed tenant and private state version. Normal query writes advance the version, fencing stale documents even when the status did not change. Public conversation/lead document serialization hides the version. The one runtime Conversation bulk snapshot path explicitly advances that same version. Other protected-model native collection/bulk writes are not an authorized route for runtime feature development; migrations require explicit review. The source inventory remains a conservative inventory, not whole-program authorization proof.

Central cancellation and staff-outcome commands now reject illegal state transitions. Existing confirmation leases, transaction/session propagation, unique slot indexes and request-state predicates remain in force. A compare-and-set conflict can fail an operation that previously silently overwrote another write; callers must reload/replay rather than treating that conflict as success.

## Media and logout

Media downloads have a ten-second deadline, five-MiB byte limit checked during reading, explicit provider redirect validation, no credential forwarding to the CDN, and bounded per-tenant/process concurrency. Client disconnection aborts work. Only recognized passive image/audio/video formats retain inline previews; active or unknown document types are downloaded as inert attachments with restrictive CSP and nosniff headers. These per-process limits complement infrastructure limits; they are not a global fleet capacity guarantee.

Admin logout now uses the shared verified logout operation. A failed logout keeps the current screen and an actionable error rather than claiming that the HttpOnly session was cleared.

## Maintainability

A2P input/validation policy is separated from provider orchestration. Invoice allocation policy is separated from reporting I/O. Appointment listing, inbound SMS record lookup, staff follow-up delivery and lead-reply persistence have cohesive boundaries. Login display/error policy, marketing presentation, admin queue commands and signup orchestration have cohesive modules. No complexity limit was increased; existing exception budgets are tightened after reductions. Remaining large functions are debt, not a claim of completed application-wide decomposition.

Thirteen relocation-only source pins were retired explicitly where semantic fixes or policy extraction changed their owners; untouched migration owners remain source-pinned. The changed paths have behavioral tests. Neither coverage thresholds nor safety assertions are reduced to accept the corrections. Test fixture passwords and existing admin clients are updated to the intended security contract.

## CI and account settings

The API engine and scale job use Node 24 LTS consistently. Paired browser runs accept an explicit partner ref, record both revisions, and can use a scoped cross-repository read token for both checkouts. Private dependency changes receive an actual locked-tree audit. Secret-history scanning runs separately from the fast tracked-source scan. Reviewed historical false positives have exact commit/file/rule/line fingerprints, not whole-file or global exclusions.

The package includes scripts/configure-release-protection.py. Preview is the default; --apply uses the operator's authenticated GitHub CLI to enforce and verify required checks, administrator enforcement, and blocked force pushes/deletions on main/development. It does not require PRs. Configure CALLBACKIQ_CROSS_REPO_READ_TOKEN in both repositories with access to both private repositories, or use a suitable GitHub App/token workflow. Installation permissions are GitHub account settings, not repository source changes.

Live account settings and production configuration cannot be certified by downloading code. Read the delivered verification report for exact executed checks and remaining external actions. No claim of an independent security review or production sign-off is made.
