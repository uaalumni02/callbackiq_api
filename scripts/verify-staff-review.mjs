import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const extra = [
 'tests/unit/opportunityValue.test.js',
 'tests/unit/opportunityValuation.concurrent.test.js',
 'tests/unit/staffReview.crossTrade.test.js',
 'tests/unit/trialLifecycle.runtimeWiring.test.js',
 'tests/unit/interventionEscalation.test.js',
 'tests/unit/smsStaffReviewRecovery.test.js',
 'tests/unit/smsProductionHandoff.regression.test.js',
 'tests/controllers/intervention.audit.completion.test.js',
 'tests/controllers/intervention.completion.test.js',
 'tests/unit/customerCommitmentSafety.regression.test.js',
 'tests/unit/aiGuardrails.branch.full.test.js',
 'tests/routes/aiGuardrails.emergency.test.js',
];
const result = spawnSync(process.execPath, ['scripts/verify-sms-voice-conversation-release.mjs', '--runTestsByPath', ...extra], { cwd, stdio: 'inherit', env: process.env });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
