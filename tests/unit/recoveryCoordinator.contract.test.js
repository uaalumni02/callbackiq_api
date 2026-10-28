import { validateFacts, validateDecision, nextReviewState, operationKey, requiredVersion } from '../../src/services/recoveryCoordinator/contract.js';
import {fingerprintRequest} from '../../src/services/recoveryCoordinator/acceptanceGate.js';

test('facts are strictly whitelisted and bounded',()=>{
  expect(validateFacts({customerName:'  Jordan Smith  ',serviceNeeded:' Sink repair '})).toEqual({customerName:'Jordan Smith',serviceNeeded:'Sink repair'});
  expect(()=>validateFacts({business:'another tenant'})).toThrow('reviewed customer facts');
  expect(()=>validateFacts({customerName:'Missed Call Lead'})).toThrow('actual customer name');
  expect(()=>validateFacts({address:'x'.repeat(501)})).toThrow('Invalid');
});
test('decisions require an actual offering and a meaningful reason',()=>{
  expect(()=>validateDecision({decision:'accepted',reason:'Approved by staff review',serviceOfferingId:'nope'})).toThrow('configured');
  expect(validateDecision({decision:'declined',reason:'We do not serve this address'}).decision).toBe('declined');
});
test('terminal and declined requests cannot be silently reapproved',()=>{
  for(const status of ['booked','closed','declined'])expect(()=>nextReviewState({status},'accepted')).toThrow();
});
test('operation keys and versions fail closed',()=>{
  expect(()=>requiredVersion('1')).toThrow();expect(()=>requiredVersion(-1)).toThrow();
  expect(()=>operationKey('short')).toThrow();expect(operationKey('recover-unique-operation-1')).toBe('recover-unique-operation-1');
});
test('approval fingerprint binds to exact request facts',()=>{
  expect(fingerprintRequest('sink repair')).toBe(fingerprintRequest('sink repair '));
  expect(fingerprintRequest('sink repair')).not.toBe(fingerprintRequest('roof repair'));
});

test('rejects non-string and empty fact corrections',()=>{
  expect(()=>validateFacts({address:''})).toThrow();
  expect(()=>validateFacts({serviceNeeded:null})).toThrow();
});
