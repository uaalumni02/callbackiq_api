import RecoveryCase from '../../src/models/recoveryCase.js';
import {assertRecoveryCaseAcceptance,fingerprintRequest} from '../../src/services/recoveryCoordinator/acceptanceGate.js';
jest.mock('../../src/models/recoveryCase.js',()=>({__esModule:true,default:{findOne:jest.fn(),exists:jest.fn()}}));
const id='507f1f77bcf86cd799439011';
const offering='507f1f77bcf86cd799439012';
const original={};
beforeAll(()=>{for(const key of ['MEEKCALL_RECOVERY_REQUIRE_SERVICE_DECISION','MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS'])original[key]=process.env[key]});
afterAll(()=>{for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
beforeEach(()=>{
  jest.clearAllMocks();
  process.env.MEEKCALL_RECOVERY_REQUIRE_SERVICE_DECISION='true';
  process.env.MEEKCALL_RECOVERY_PILOT_BUSINESS_IDS=id;
});
const mockCase=value=>RecoveryCase.findOne.mockReturnValue({sort:()=>({select:()=>({lean:async()=>value})})});
test('a matching audited decision authorizes only the specific request',async()=>{
  mockCase({status:'accepted',facts:{serviceNeeded:'Sink draining slowly'},serviceDecision:{decision:'accepted',serviceOfferingId:offering,requestFingerprint:fingerprintRequest('Sink draining slowly')}});
  await expect(assertRecoveryCaseAcceptance({businessId:id,conversationId:id,serviceOfferingId:offering,actualRequest:'Sink draining slowly'})).resolves.toBeUndefined();
  await expect(assertRecoveryCaseAcceptance({businessId:id,conversationId:id,serviceOfferingId:offering,actualRequest:'Roof replacement'})).rejects.toMatchObject({code:'RECOVERY_SERVICE_ACCEPTANCE_REQUIRED'});
});
test('a declined or mismatched service cannot be booked',async()=>{
  mockCase({status:'declined',facts:{serviceNeeded:'Sink draining slowly'},serviceDecision:{decision:'declined',serviceOfferingId:offering,requestFingerprint:fingerprintRequest('Sink draining slowly')}});
  await expect(assertRecoveryCaseAcceptance({businessId:id,conversationId:id,serviceOfferingId:offering,actualRequest:'Sink draining slowly'})).rejects.toMatchObject({statusCode:409});
});
test('lead-only booking cannot bypass an initialized pilot recovery record',async()=>{
  RecoveryCase.exists.mockResolvedValue({_id:id});
  await expect(assertRecoveryCaseAcceptance({businessId:id,leadId:id,serviceOfferingId:offering,actualRequest:'Sink draining slowly'})).rejects.toMatchObject({code:'RECOVERY_CONVERSATION_REQUIRED'});
});
test('non-pilot businesses retain existing behavior',async()=>{
  await expect(assertRecoveryCaseAcceptance({businessId:'507f1f77bcf86cd799439099',conversationId:id,serviceOfferingId:offering,actualRequest:'Sink draining slowly'})).resolves.toBeUndefined();
  expect(RecoveryCase.findOne).not.toHaveBeenCalled();
});
