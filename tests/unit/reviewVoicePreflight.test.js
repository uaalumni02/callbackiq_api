jest.mock('../../src/services/webhooks/webhookWork.service.js',()=>({enqueueWebhookWork:jest.fn().mockResolvedValue({_id:'safety-job'})}));
import { runVoiceConversationTurn } from '../../src/services/voiceConversationTurn.service.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import { withDistributedLease, registerDistributedLeaseGuard } from '../../src/services/distributedLease.service.js';
import { runWithVoiceTurnContext } from '../../src/services/voiceTurnContext.service.js';
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/models/lead.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/services/distributedLease.service.js',()=>({withDistributedLease:jest.fn(),registerDistributedLeaseGuard:jest.fn(),assertDistributedLeaseActive:jest.fn()}));
let session,conversation,lead,operation;
beforeEach(()=>{
 jest.clearAllMocks();
 conversation={_id:'c',business:'b',lead:'l',status:'open',orchestration:{activeVoiceIntakeSession:'v'},conversationMemory:{recoveryIntake:{address:'SMS-updated address'}}};
 lead={_id:'l',business:'b',address:'SMS-updated address'};
 session={_id:'v',business:{_id:'b'},conversation:{_id:'c'},lead:{_id:'l',address:'stale'}};
 Conversation.findOne.mockResolvedValue(conversation);Lead.findOne.mockResolvedValue(lead);
 withDistributedLease.mockImplementation(async(key,work)=>({acquired:true,value:await work()}));
 operation=jest.fn(async()=>({reply:session.lead.address}));
});
test('an address must not end an ordinary urgent repair call',async()=>{
 const r=await runVoiceConversationTurn({session,customerMessage:'My toilet is overflowing at 123 Main Street Atlanta GA 30324',operation,turnId:'review-address'});
 console.log('VOICE_WRAPPER_PROBE',JSON.stringify({reply:r.reply,outcome:r.outcome,handoff:r.handoff,operationCalls:operation.mock.calls.length}));
 expect(r.handoff?.type).not.toBe('end');
 expect(operation).toHaveBeenCalled();
});
