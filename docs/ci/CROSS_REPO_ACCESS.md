# Cross-repository browser CI access — MeekCall

## Verified failure

At API `e51679e1` and frontend `0ed3b566`, both browser workflows failed at `Checkout partner repository`, **before** running Playwright. The runner said `Repository not found` for the sibling checkout. Both repository metadata responses currently say `visibility=public`, which is inconsistent with assuming they are definitely private; check actual repo settings/token grants.

## Owner-only setup (no secrets in files)

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, or create a GitHub App with read-only Contents access. Restrict the credential to `uaalumni02/callbackiq_api` and `uaalumni02/callbackiq_frontend` with **Contents: Read-only**. If your GitHub account/org security policy requires approval, obtain it. Set a short expiry and maintain rotation securely.
2. In **each repository**, open **Settings → Secrets and variables → Actions → New repository secret**. Name it exactly `MEEKCALL_CROSS_REPO_TOKEN`; paste the credential through GitHub's secret UI. Never put it in a shell history, `.env`, commit, screenshot or bug report.
3. Review whether `vars.CALLBACKIQ_FRONTEND_REF` / `vars.CALLBACKIQ_API_REF` are set. The prepared patch preserves their existing fallback to `main`. For a development PR, prefer explicitly pinned partner commit/branch in a separate tested change to avoid cross-version drift.
4. Open one PR per repository from `refactor/phase1-*` into `development`, allow CI to run and verify the two distinct exact SHAs recorded in the `browser-results` artifact. A successful checkout alone is insufficient: Playwright must actually run and pass.
5. If the check fails, inspect the *Verify cross-repository checkout credential* step for a missing secret. If the actual checkout still returns 404, check token repository selection, token expiration, organization approval, repository name, and whether the runner can access both repos. Do not disable the browser job or grant write access to solve a read problem.

## Workflows preserved

- Existing checkout action `actions/checkout@v6` and pinned Node 24.19.0.
- Job directories `api` and `frontend` and existing frontend build environment.
- Playwright Chromium install and `npm run test:browser` in API project.
- `browser-results` upload, including commit manifests when checkout succeeds.

## Risk and rollback

The workflow intentionally fails early until the owner completes setup. If needed, restore from the installer backup; do not merge an intentionally red change without documented reason.
