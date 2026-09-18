jest.mock('../../src/services/distributedLease.service.js',()=>({withDistributedLease:jest.fn(async(key,fn)=>({acquired:true,value:await fn()}))}));
import { voiceSafetyReviewReply, processVoiceSafetyReview } from '../../src/services/voiceSafetyReview.service.js';
import { enqueueWebhookWork } from '../../src/services/webhooks/webhookWork.service.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import VoiceSession from '../../src/models/voiceSession.js';
import AlertService from '../../src/services/alert.service.js';
jest.mock('../../src/services/webhooks/webhookWork.service.js',()=>({enqueueWebhookWork:jest.fn()}));
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{findOne:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/models/lead.js',()=>({__esModule:true,default:{updateOne:jest.fn()}}));
jest.mock('../../src/models/voiceSession.js',()=>({__esModule:true,default:{findOne:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/services/alert.service.js',()=>({__esModule:true,default:{create:jest.fn()}}));
const session={_id:'v',business:{_id:'b'},conversation:{_id:'c'},lead:{_id:'l'}};
beforeEach(()=>{jest.clearAllMocks();enqueueWebhookWork.mockResolvedValue({_id:'job'});VoiceSession.findOne.mockResolvedValue(session);Conversation.findOne.mockResolvedValue({_id:'c',lead:'l',humanTakeover:true});AlertService.create.mockResolvedValue({alert:{_id:'a'}});});
test.each(['I smell gas','The outlet is sparking and smoking','My basement is flooding','The roof is collapsing'])('records %s without promises or intake mutation',async text=>{
 const result=await voiceSafetyReviewReply({session,customerMessage:text,turnId:'7'});
 expect(result.reply).toMatch(/does not monitor emergencies or dispatch emergency help/);
 expect(result.reply).toMatch(/Do not wait/);
 expect(result.outcome).toBe('safety_guidance');expect(result.handoff.type).toBe('end');
 expect(result.reply).not.toMatch(/team (?:has|will)|dispatched|on the way|guaranteed|alerted/i);
 const queued=enqueueWebhookWork.mock.calls[0][0];expect(queued.kind).toBe('voice_safety_review');
 await processVoiceSafetyReview(queued.payload);
 expect(Lead.updateOne).toHaveBeenCalledWith({_id:'l',business:'b',urgency:{$ne:'emergency'}},{$set:{urgency:'emergency'}});
 expect(AlertService.create).toHaveBeenCalledWith(expect.objectContaining({actionRequired:true,priority:'critical',dueAt:expect.any(Date),conversationId:'c'}));
 expect(Conversation.updateOne.mock.calls[0][1]).toEqual({$set:{'conversationMemory.urgency':'emergency'}});
});
test('replay uses stable event identity; different turns remain distinct',async()=>{
 for(const turnId of ['1','1','2']) await voiceSafetyReviewReply({session,customerMessage:'I smell gas',turnId});
 const ids=enqueueWebhookWork.mock.calls.map(([a])=>a.eventId);expect(ids[0]).toBe(ids[1]);expect(ids[2]).not.toBe(ids[0]);
});
test('failed queue insert cannot replace safety guidance with callback reassurance',async()=>{
 enqueueWebhookWork.mockRejectedValue(new Error('database unavailable'));
 expect((await voiceSafetyReviewReply({session,customerMessage:'I smell gas'})).reply).toMatch(/Do not wait/);
});
test('slow persistence does not delay safety guidance indefinitely',async()=>{
 jest.useFakeTimers();enqueueWebhookWork.mockReturnValue(new Promise(()=>{}));
 const pending=voiceSafetyReviewReply({session,customerMessage:'I smell gas'});
 await jest.advanceTimersByTimeAsync(401);expect((await pending).reply).toMatch(/Do not wait/);jest.useRealTimers();
});
test('missing tenant-scoped session cannot update another request',async()=>{
 await voiceSafetyReviewReply({session,customerMessage:'I smell gas'});
 VoiceSession.findOne.mockResolvedValue(null);
 await expect(processVoiceSafetyReview(enqueueWebhookWork.mock.calls[0][0].payload)).rejects.toMatchObject({code:'SAFETY_CONTEXT_MISSING'});
 expect(Lead.updateOne).not.toHaveBeenCalled();
});
test('ordinary and negated safety messages do not create emergency jobs',async()=>{
 for(const text of ['My faucet needs replacement','There is no gas smell']) expect(await voiceSafetyReviewReply({session,customerMessage:text})).toBeNull();
 expect(enqueueWebhookWork).not.toHaveBeenCalled();
});
