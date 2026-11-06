# Browser cross-repository access (public repositories)

## Current status, November 5, 2026

Both `uaalumni02/callbackiq_api` and `uaalumni02/callbackiq_frontend` were
verified as **public**. The earlier browser workflow failed because its
Phase 1 change *required* `MEEKCALL_CROSS_REPO_TOKEN`, which was not set.
The earlier checkout error occurred while repository visibility was different;
it is not evidence that a private access credential is needed now.

## Credential policy

The sibling checkout retains `actions/checkout@v6`, `contents: read` and
`persist-credentials: false`, using:

```yaml
    token: ${{ secrets.CALLBACKIQ_CROSS_REPO_READ_TOKEN || github.token }}
```

For public repositories no PAT is required. `github.token` is automatically
available to the job and can read a public partner repository. The optional
`CALLBACKIQ_CROSS_REPO_READ_TOKEN` secret becomes relevant if a sibling is made
private later. If repository visibility changes, verify checkout permissions
and use a fine-grained Contents: read credential (or installation token) with
only the necessary repository access; never grant write access to fix checkout.

The previous *mandatory* `MEEKCALL_CROSS_REPO_TOKEN` check is removed because
it prevented public-repo browser tests from starting. This is a deliberate
change to the workflow access contract, not a disabled test or CI job.

## Validation

1. Run `node scripts/meekcall-architecture-contracts.mjs` and
   `node --test hardening-tests/phase1-cross-repo-checkout.test.mjs` in **both**
   refactor branches.
2. Push changes to the existing PR branches, not `main`/`development`.
3. Verify PR CI, security and dependency-review checks; the PR's prior failed
   runs will not turn green merely because repository visibility changed.
4. Confirm the browser workflow checks out both repositories, records two
   exact SHAs, installs dependencies, builds the frontend and executes Playwright.
   A green checkout by itself is not browser E2E certification.
5. For Dependency Review, ensure GitHub's Dependency graph is enabled in both
   public repositories. Public visibility permits supported dependency review
   but does not retroactively repair a failed run.

## Important security consequence

These repositories are now publicly readable. Review tracked content for
secrets and inappropriate business data. Do not publish live credentials.
