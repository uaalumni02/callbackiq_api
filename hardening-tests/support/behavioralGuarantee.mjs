import assert from 'node:assert/strict';
import {behavioralContract} from './behavioralContract.mjs';
export const persistenceContracts=[
 'tests/integration/productionContracts.persistence.test.js',
 'tests/integration/smsUsagePriority.persistence.test.js',
 'tests/integration/smsDispatchBoundary.persistence.test.js',
 'tests/integration/communicationUsageRollback.persistence.test.js',
];
export const confirmationContracts=[
 'tests/integration/appointmentConfirmationCrashReplicaSet.concurrency.test.js',
 'tests/unit/appointmentConfirmation.postCommitBoundary.test.js',
 'tests/unit/maintainability.release9.holdExpiry.test.js',
];
export async function behavioralGuarantee(suites,pattern){
 const report=await behavioralContract(suites);
 const matches=report.testResults.flatMap(row=>row.assertionResults).filter(row=>pattern.test(row.fullName));
 assert.ok(matches.length,`No executable behavior implements ${pattern}`);
 for(const row of matches)assert.equal(row.status,'passed',row.fullName);
 return matches.length;
}
