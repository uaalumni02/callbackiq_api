import AlertService from '../../src/services/alert.service.js';
import VoiceHandoff from '../../src/voice/voiceHandoff.service.js';
import Alert from '../../src/models/alert.js';
import { escalateOverdueInterventions } from '../../src/services/interventionEscalation.service.js';
jest.mock('../../src/models/alert.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn(),find:jest.fn()}}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertCreated:jest.fn(),emitAlertUpdated:jest.fn(),emitDashboardRefresh:jest.fn(),emitConversationUpdated:jest.fn()}}));
afterEach(()=>jest.restoreAllMocks());
test('critical inbound SMS uses strict persistence and the same dedupe key as its later handoff',async()=>{
 const create=jest.spyOn(AlertService,'create').mockResolvedValue({alert:{_id:'a'}});
 await AlertService.createCustomerReplyAlert({businessId:'b',conversationId:'c',providerMessageId:'SM1',messageBody:'Sparking panel',priority:'critical'});
 expect(create).toHaveBeenCalledWith(expect.objectContaining({businessId:'b',conversationId:'c',type:'safety_emergency',actionRequired:true,dueAt:expect.any(Date),dedupeKey:'human_handoff:SM1'}));
 create.mockRejectedValueOnce(new Error('write failed'));
 await expect(AlertService.createCustomerReplyAlert({businessId:'b',providerMessageId:'SM2',priority:'critical'})).rejects.toThrow('write failed');
});
test('ordinary urgent AI review has an actionable type and deadline',async()=>{
 const create=jest.spyOn(AlertService,'create').mockResolvedValue({alert:{_id:'a'}});
 await AlertService.createAIReviewAlert({businessId:'b',conversationId:'c',result:{urgency:'high',alertPriority:'high'}});
 expect(create).toHaveBeenCalledWith(expect.objectContaining({type:'human_requested',actionRequired:true,dueAt:expect.any(Date)}));
});
test('voice handoff is pending, becomes overdue, and never claims staff acceptance',async()=>{
 const session={_id:'s',business:{_id:'b'},lead:{_id:'l'},metadata:{},save:jest.fn().mockResolvedValue(null)};
 Alert.findOneAndUpdate.mockResolvedValue({_id:'a',business:'b'});
 await VoiceHandoff.request({session,reason:'safety',priority:'critical'});
 expect(session.transferredToHuman).toBe(false);
 const input=Alert.findOneAndUpdate.mock.calls[0][1].$setOnInsert;
 expect(input).toMatchObject({actionRequired:true,status:'pending',dueAt:expect.any(Date)});
 expect(input.acknowledgedAt).toBeUndefined();
 const query={sort:()=>query,limit:()=>query,select:()=>query,lean:async()=>[{_id:'a',business:'b'}]};Alert.find.mockReturnValue(query);
 const now=new Date(+input.dueAt+1);
 expect(await escalateOverdueInterventions({now})).toEqual({escalated:1});
 const update=Alert.findOneAndUpdate.mock.calls.at(-1);
 expect(update[0]).toMatchObject({business:'b',acknowledgedAt:null,resolvedAt:null,dueAt:{$lte:now,$ne:null}});
 expect(update[1].$set).toEqual({priority:'critical','metadata.reviewEscalatedAt':now});
});
