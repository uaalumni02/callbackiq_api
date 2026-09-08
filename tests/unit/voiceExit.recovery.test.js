import { handleVoiceExit } from '../../src/voice/voiceExit.service.js';
import { optOutSms } from '../../src/services/messaging/contactPreference.service.js';
jest.mock('../../src/services/messaging/contactPreference.service.js',()=>({optOutSms:jest.fn()}));
const make=()=>({business:{_id:'b1'},from:'+14045550100',lead:{notes:'existing',save:jest.fn()},conversation:{save:jest.fn()},save:jest.fn()});
beforeEach(()=>{jest.clearAllMocks();optOutSms.mockResolvedValue({smsStatus:'opted_out'});});
test.each(['stop texting me',"don't call me",'stop calling me','wrong number'])('voice exit is persisted before acknowledgment: %s',async text=>{
 const session=make(); const r=await handleVoiceExit({session,customerMessage:text}); expect(r.handoff.type).toBe('end');expect(session.conversation.aiEnabled).toBe(false);expect(optOutSms).toHaveBeenCalled();expect(session.save).toHaveBeenCalled();
});
test('ordinary stop-related service text does not opt out',async()=>{expect(await handleVoiceExit({session:make(),customerMessage:'My toilet will not stop leaking'})).toBeNull();expect(optOutSms).not.toHaveBeenCalled();});
test('failure to save opt-out is not acknowledged as success',async()=>{optOutSms.mockRejectedValue(new Error('db down'));await expect(handleVoiceExit({session:make(),customerMessage:'stop texting me'})).rejects.toThrow('db down');});
