#!/usr/bin/env bash
set -euo pipefail

npx jest \
  tests/middleware/socket-auth.full.test.js \
  tests/unit/aiGuardrails.branch.full.test.js \
  tests/middleware/validate-twilio-signature.full.test.js \
  tests/controllers/legacy-controllers.branch.full.test.js \
  tests/unit/socket.service.branch.full.test.js \
  tests/unit/turnstile.full.test.js \
  tests/middleware/error-handler.full.test.js \
  tests/unit/connection.full.test.js \
  --runInBand \
  --no-watchman
