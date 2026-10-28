import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFacts, validateDecision, operationKey, requiredVersion, nextReviewState} from '../src/services/recoveryCoordinator/contract.js';

test('facts are whitelisted and dangerous fields are rejected',()=>{
  assert.deepEqual(validateFacts({customerName:' Jordan Smith ',serviceNeeded:' Drain clearance '}),{customerName:'Jordan Smith',serviceNeeded:'Drain clearance'});
  assert.throws(()=>validateFacts({business:'another tenant'}));
  assert.throws(()=>validateFacts({customerName:'Missed Call Lead'}));
  assert.throws(()=>validateFacts({serviceNeeded:''}));
});
test('decisions require explicit reason and verified offering identity',()=>{
  assert.throws(()=>validateDecision({decision:'accepted',serviceOfferingId:'x',reason:'Appropriate service verified by the business'}));
  assert.equal(validateDecision({decision:'declined',reason:'We do not perform this kind of work'}).decision,'declined');
  assert.throws(()=>nextReviewState({status:'declined'},'accepted'));
  assert.throws(()=>nextReviewState({status:'booked'},'accepted'));
});
test('operation ids and versions fail closed',()=>{
  assert.throws(()=>operationKey('x'));
  assert.throws(()=>requiredVersion('1'));
  assert.equal(operationKey('recovery-action-unique-001'),'recovery-action-unique-001');
});
