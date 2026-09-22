import Alert from '../../src/models/alert.js';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import { requestReviewKey, isRequestReview, saveRequestReview } from '../../src/services/requestReview.service.js';
jest.mock('../../src/models/alert.js', () => ({__esModule:true,default:{updateOne:jest.fn(),findOne:jest.fn()}}));
jest.mock('../../src/models/conversation.js', () => ({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/models/message.js', () => ({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/services/socket.service.js', () => ({__esModule:true,default:{emitAlertUpdated:jest.fn()}}));
const query = value => { const q={select:()=>q,populate:()=>q,lean:async()=>value};return q; };
const payload={businessId:'b',conversationId:'c',type:'human_requested',dedupeKey:'ai_review:SM1',title:'Urgent',message:'Leak',priority:'high',metadata:{messageId:'m',providerMessageId:'SM1'}};
const saved={_id:'a',createdAt:new Date('2026-09-22T12:00:00Z'),assignedTo:'owner',acknowledgedAt:new Date()};
beforeEach(()=>{jest.clearAllMocks();Conversation.findOne.mockReturnValue(query({orchestration:{recoveryJourneyKey:'j1'}}));Message.findOne.mockReturnValue(query({createdAt:new Date('2026-09-22T12:01:00Z')}));Alert.findOne.mockReturnValue(query(saved));});
test('SMS urgency and completed intake share a request key, with message IDs preserved in history',async()=>{
 const create=jest.fn().mockResolvedValue({alert:saved,created:false});
 await saveRequestReview(payload,create);
 await saveRequestReview({...payload,dedupeKey:'human_handoff:SM2',metadata:{messageId:'m2',intakeReview:{address:'907 Run Rd'}}},create);
 expect(create.mock.calls.map(([p])=>p.dedupeKey)).toEqual([requestReviewKey('c','j1'),requestReviewKey('c','j1')]);
 expect(Alert.updateOne).toHaveBeenCalledWith(expect.objectContaining({'reviewEvents.key':{$ne:'ai_review:SM1'}}),expect.objectContaining({$push:{reviewEvents:expect.objectContaining({key:'ai_review:SM1',providerMessageId:'SM1'})}}));
 const writes=Alert.updateOne.mock.calls.map(([,update])=>update.$set||{});
 for(const write of writes) for(const field of ['status','assignedTo','acknowledgedAt','resolvedAt','dueAt']) expect(write).not.toHaveProperty(field);
});
test('guards against stale facts, phase regression and reopening a resolved review',async()=>{
 await saveRequestReview(payload,jest.fn().mockResolvedValue({alert:saved,created:false}));
 const [filter]=Alert.updateOne.mock.calls.find(([,u])=>u.$set?.title);
 expect(filter.resolvedAt).toBeNull();
 expect(filter.$and).toEqual(expect.arrayContaining([expect.objectContaining({$or:[{reviewPhase:null},{reviewPhase:{$lte:1}}]})]));
});
test('scopes by tenant and journey; leaves safety and delivery exceptions separate',()=>{
 expect(requestReviewKey('c','j1')).not.toBe(requestReviewKey('c','j2'));
 expect(isRequestReview(payload)).toBe(true);
 expect(isRequestReview({...payload,type:'safety_emergency'})).toBe(false);
 expect(isRequestReview({...payload,type:'message_delivery_failure'})).toBe(false);
});
test('fails closed when conversation lookup or durable history fails',async()=>{
 const create=jest.fn(); Conversation.findOne.mockReturnValue(query(null));
 await expect(saveRequestReview(payload,create)).rejects.toThrow('scoped conversation');expect(create).not.toHaveBeenCalled();
 Conversation.findOne.mockReturnValue(query({orchestration:{}}));create.mockResolvedValue({alert:saved});
 Alert.updateOne.mockRejectedValueOnce(new Error('database unavailable'));
 await expect(saveRequestReview(payload,create)).rejects.toThrow('database unavailable');
});
