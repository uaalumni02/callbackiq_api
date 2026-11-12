import test from 'node:test';
import { behavioralContract } from './support/behavioralContract.mjs';

test("canonical MongoDB configuration supports MONGODB_URI", () => behavioralContract(["tests/unit/productionHardening.runtimeEnvironment.test.js"]));

test("startup validates environment before connecting", () => behavioralContract(["tests/integration/releaseSecurity.behavior.test.js"]));

test("production CORS does not always trust localhost", () => behavioralContract(["tests/integration/cors.idempotencyPreflight.10of10.test.js", "tests/config/env.test.js"]));

test("password reset tokens are hashed before persistence and lookup", () => behavioralContract(["tests/routes/auth.routes.test.js"]));

test("production auth response does not expose bearer token", () => behavioralContract(["tests/integration/releaseSecurity.behavior.test.js"]));

test("conversation admin bypass re-checks current database role", () => behavioralContract(["tests/integration/releaseSecurity.behavior.test.js"]));

test("registration is transaction-backed", () => behavioralContract(["tests/integration/registrationTransactionReplicaSet.contract.test.js"]));

test("growth endpoints use bounded cursor pagination", () => behavioralContract(["tests/integration/scaleQueryPersistence.test.js", "tests/unit/productionHardening.cursorPagination.test.js"]));

test("A2P reconciliation uses a distributed lease", () => behavioralContract(["tests/integration/providerBoundaries.behavior.test.js"]));

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('production CORS rejects an unconfigured localhost origin', () => {
  const result = spawnSync(process.execPath,['--input-type=module','-e',
    "import {isAllowedOrigin} from './src/config/cors.js'; if(isAllowedOrigin('http://localhost:3001')) process.exit(1);"],
    {env:{...process.env,NODE_ENV:'production',CLIENT_URL:'https://meekcall.com',FRONTEND_URL:'',ALLOWED_ORIGINS:''},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
test('release and index gates execute their validation contracts', () => {
  const result = spawnSync(process.execPath,['scripts/migrate-required-indexes.mjs','--check-manifest'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
