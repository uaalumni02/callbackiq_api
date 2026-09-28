import OpenAI from 'openai';
import mongoose from 'mongoose';
import ServiceOffering from '../../src/models/serviceOffering.js';
import Intelligence from '../../src/models/conversationIntelligence.js';
import Service from '../../src/services/conversationIntelligence.service.js';
import { VALID_ACTION_TYPES, VALID_RISK_TYPES } from '../../src/services/conversationIntelligence.contract.js';
jest.mock('openai', () => ({__esModule:true, default:jest.fn()}));
jest.mock('../../src/models/serviceOffering.js', () => ({__esModule:true,default:{find:jest.fn()}}));
const create=jest.fn();
const business={_id:new mongoose.Types.ObjectId()};
const conversation={_id:new mongoose.Types.ObjectId()};
let payload;
beforeAll(()=>{process.env.OPENAI_API_KEY='offline-test-placeholder';OpenAI.mockImplementation(()=>({responses:{create}}));});
afterEach(()=>jest.restoreAllMocks());
beforeEach(()=>{
  jest.spyOn(console,'error').mockImplementation(()=>{});
  create.mockClear();ServiceOffering.find.mockReturnValue({lean:async()=>[]});
  payload={summary:'Customer requests sink repair.',customerIntent:{primary:'Sink repair',category:'repair',serviceType:'Sink repair'},nextBestAction:{action:'Call customer',actionType:'call_soon',suggestedMessage:'Thank you for your message.'},urgency:{level:'normal',score:50},buyingLikelihood:{score:50},overallConfidence:80};
  create.mockImplementation(async()=>({output_text:JSON.stringify(payload)}));
});
const analyze=()=>Service.analyze({business,conversation,lead:null,messages:[{direction:'inbound',body:'Need a sink repair',createdAt:new Date()}]});
const document=result=>new Intelligence({...result,business:business._id,conversation:conversation._id});
test.each(VALID_ACTION_TYPES)('provider action %s survives normalization and model validation',async actionType=>{
  payload.nextBestAction.actionType=actionType;const result=await analyze();expect(result.nextBestAction.actionType).toBe(actionType);await expect(document(result).validate()).resolves.toBeUndefined();
});
test.each(VALID_RISK_TYPES)('provider risk %s survives normalization and model validation',async type=>{
  payload.riskFlags=[{type,severity:'medium',explanation:'Review this risk'}];const result=await analyze();expect(result.riskFlags).toContainEqual(payload.riskFlags[0]);await expect(document(result).validate()).resolves.toBeUndefined();
});
test.each(['send_estimate','schedule_appointment'])('legacy stored action %s remains readable/valid',async actionType=>{
  await expect(document({...payload,nextBestAction:{...payload.nextBestAction,actionType}}).validate()).resolves.toBeUndefined();
  payload.nextBestAction.actionType=actionType;expect(VALID_ACTION_TYPES).toContain((await analyze()).nextBestAction.actionType);
});
test.each([0,1,25,100])('preserves percentage score %s',async score=>{payload.buyingLikelihood.score=score;payload.overallConfidence=score;payload.appointmentProbability={score};payload.urgency.score=score;const result=await analyze();expect(result.buyingLikelihood.score).toBe(score);expect(result.appointmentProbability.score).toBe(score);expect(result.overallConfidence).toBe(score);expect(result.urgency.score).toBe(score);});
test('bounded normalized strings satisfy all schema length validators',async()=>{
  const huge='x'.repeat(3000);payload.summary=huge;payload.customerIntent.primary=huge;payload.customerIntent.serviceType=huge;payload.sentiment={label:'neutral',score:0,explanation:huge};payload.urgency.reason=huge;payload.nextBestAction.action=huge;payload.nextBestAction.suggestedMessage=huge;payload.objections=[{category:'price',description:huge}];payload.riskFlags=[{type:'other',severity:'medium',explanation:huge}];
  const result=await analyze();expect(result.summary).toHaveLength(2000);await expect(document(result).validate()).resolves.toBeUndefined();
});
test('unknown intent and no action are valid conservative outcomes',async()=>{payload.customerIntent={primary:'Unknown',category:'unknown',serviceType:''};payload.nextBestAction.actionType='none';payload.overallConfidence=0;await expect(document(await analyze()).validate()).resolves.toBeUndefined();});
test('retains guardrail audit metadata without owning staff completion fields',async()=>{const result=await analyze();const d=document(result).toObject();expect(d.nextBestAction.suggestedMessageGuardrail.usedFallback).toBe(result.nextBestAction.suggestedMessageGuardrail.usedFallback);expect(result.nextBestAction).not.toHaveProperty('completed');expect(result.nextBestAction).not.toHaveProperty('outcome');});
test('empty provider output still fails instead of saving fabricated analysis',async()=>{create.mockResolvedValue({output_text:''});await expect(analyze()).rejects.toThrow('empty analysis');});
test('invalid JSON still fails',async()=>{create.mockResolvedValue({output_text:'not json'});await expect(analyze()).rejects.toThrow('invalid structured data');});
test('blank summary still fails',async()=>{payload.summary='';await expect(analyze()).rejects.toThrow('summary is missing');});
