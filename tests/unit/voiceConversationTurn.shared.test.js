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
test('same SMS lock key and tenant-scoped refresh precede voice mutation',async()=>{
 expect(await runVoiceConversationTurn({session,customerMessage:'tomorrow',operation})).toEqual({reply:'SMS-updated address'});
 expect(withDistributedLease.mock.calls[0][0]).toBe('sms-conversation:c');
 expect(Conversation.findOne).toHaveBeenCalledWith({_id:'c',business:'b'});expect(Lead.findOne).toHaveBeenCalledWith({_id:'l',business:'b'});
 expect(registerDistributedLeaseGuard).toHaveBeenCalled();
});
test('busy SMS processing cannot run a simultaneous voice mutation',async()=>{
 withDistributedLease.mockResolvedValue({acquired:false});
 const r=await runVoiceConversationTurn({session,customerMessage:'tomorrow',operation});
 expect(r.reply).toMatch(/still being processed/);expect(operation).not.toHaveBeenCalled();expect(Lead.findOne).not.toHaveBeenCalled();
});
test('busy conversation still provides hazard guidance',async()=>{
 withDistributedLease.mockResolvedValue({acquired:false});
 const r=await runVoiceConversationTurn({session,customerMessage:'I smell gas',operation});
 expect(r.reply).toMatch(/gas|leave|911/i);expect(operation).not.toHaveBeenCalled();
});
test('staff takeover prevents voice mutation from its old populated snapshot',async()=>{
 conversation.humanTakeover=true;
 const r=await runVoiceConversationTurn({session,customerMessage:'book it',operation});
 expect(r.reply).toMatch(/team review/);expect(operation).not.toHaveBeenCalled();
});
test('staff takeover during processing suppresses the superseded response',async()=>{
 Conversation.findOne.mockResolvedValueOnce(conversation).mockResolvedValueOnce({...conversation,humanTakeover:true});
 const r=await runVoiceConversationTurn({session,customerMessage:'tomorrow',operation});expect(r.reply).toMatch(/taken over/);
});
test('interrupted turn cannot refresh into new side effects',async()=>{
 const abort=new AbortController();Conversation.findOne.mockImplementation(async()=>{abort.abort();return conversation;});
 await expect(runWithVoiceTurnContext({signal:abort.signal},()=>runVoiceConversationTurn({session,customerMessage:'tomorrow',operation}))).rejects.toMatchObject({code:'VOICE_STALE_TURN'});
 expect(operation).not.toHaveBeenCalled();expect(Lead.findOne).not.toHaveBeenCalled();
});
test('missing tenant lead fails without running the agent',async()=>{
 Lead.findOne.mockResolvedValue(null);await expect(runVoiceConversationTurn({session,customerMessage:'tomorrow',operation})).rejects.toThrow(/lead no longer exists/);expect(operation).not.toHaveBeenCalled();
});

test.each(['takeover','overlap','busy','database_down'])('safety event survives %s without waiting for intake or promising a response',async mode=>{
 if(mode==='takeover') conversation.humanTakeover=true;
 if(mode==='overlap') conversation.orchestration.activeVoiceIntakeSession='other';
 if(mode==='busy') withDistributedLease.mockResolvedValue({acquired:false});
 if(mode==='database_down') withDistributedLease.mockRejectedValue(new Error('database down'));
 const {enqueueWebhookWork}=require('../../src/services/webhooks/webhookWork.service.js');
 const r=await runVoiceConversationTurn({session,customerMessage:'I smell gas',operation,turnId:9});
 expect(r.reply).toMatch(/does not monitor emergencies or dispatch emergency help/);
 expect(enqueueWebhookWork).toHaveBeenCalledWith(expect.objectContaining({kind:'voice_safety_review',businessId:'b',payload:expect.objectContaining({conversationId:'c'})}));
 expect(withDistributedLease).not.toHaveBeenCalled();expect(operation).not.toHaveBeenCalled();
});

test('queue failure still gives emergency guidance without a delivery promise',async()=>{
 const {enqueueWebhookWork}=require('../../src/services/webhooks/webhookWork.service.js');
 enqueueWebhookWork.mockRejectedValueOnce(new Error('queue unavailable'));
 const result=await runVoiceConversationTurn({session,customerMessage:'I smell gas',operation,turnId:'queue-failure'});
 expect(result.reply).toMatch(/911/);expect(result.reply).toMatch(/does not monitor emergencies or dispatch emergency help/i);
 expect(result.reply).not.toMatch(/(?:team|staff) (?:has been|was) (?:notified|alerted)|help is on the way|dispatching/i);
 expect(operation).not.toHaveBeenCalled();
});
