import Orchestrator from '../../src/services/conversationOrchestrator.service.js';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import { generateAIReplyResult } from '../../src/services/aiReplyService.js';
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{findById:jest.fn(),findByIdAndUpdate:jest.fn()}}));
jest.mock('../../src/models/message.js',()=>({__esModule:true,default:{findByIdAndUpdate:jest.fn()}}));
jest.mock('../../src/services/aiReplyService.js',()=>({generateAIReplyResult:jest.fn()}));
let saved;
beforeEach(()=>{
 saved={_id:'c',bookingState:{status:'not_started'},conversationMemory:{serviceNeeded:'Faucet replacement',address:'970 Sidney Marcus Atlanta GA 30324',preferredAppointmentTime:'Tuesday afternoon',summary:'Customer wants faucet replacement',urgency:'low'}};
 Conversation.findById.mockImplementation(async()=>structuredClone(saved));
 Conversation.findByIdAndUpdate.mockImplementation(async(_,update)=>{
  for(const [path,value] of Object.entries(update.$set||{})) {
   const keys=path.split('.');let object=saved;for(const key of keys.slice(0,-1)) object=object[key] ||= {};object[keys.at(-1)]=value;
  }
  return structuredClone(saved);
 });
 Message.findByIdAndUpdate.mockResolvedValue({});
});
test.each([
 {reply:'The request is not confirmed.',decision:'send_fixed_response',serviceNeeded:'',address:'',summary:''},
 {reply:'The rough estimate is $100-$200.',decision:'send_fixed_response'},
])('read-only response retains previously persisted customer facts: %j',async result=>{
 generateAIReplyResult.mockResolvedValue(result);
 const before=structuredClone(saved.conversationMemory);
 await Orchestrator.process({business:{_id:'b'},lead:{_id:'l'},conversation:structuredClone(saved),messages:[],inboundMessage:{_id:'m',body:'What happens next?'}});
 for(const [key,value] of Object.entries(before)) expect(saved.conversationMemory[key]).toBe(value);
});
test('explicit new address updates memory without erasing service or preference',async()=>{
 generateAIReplyResult.mockResolvedValue({reply:'I have the corrected address.',decision:'send_fixed_response',address:'125 Main Street 30326'});
 await Orchestrator.process({business:{_id:'b'},lead:{_id:'l'},conversation:structuredClone(saved),messages:[],inboundMessage:{_id:'m',body:'Actually, 125 Main Street 30326'}});
 expect(saved.conversationMemory.address).toBe('125 Main Street 30326');expect(saved.conversationMemory.serviceNeeded).toBe('Faucet replacement');expect(saved.conversationMemory.preferredAppointmentTime).toBe('Tuesday afternoon');
});
