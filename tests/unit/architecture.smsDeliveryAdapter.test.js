import {createSmsMessageReader} from '../../src/services/messaging/smsMessageRead.adapter.js';
import {createSmsOutboundDelivery} from '../../src/services/messaging/smsOutboundDelivery.adapter.js';
const input=()=>({business:{_id:'tenant',phone:'+15555550000'},lead:{_id:'lead'},conversation:{_id:'conv',customerPhone:'+15555550111'},inboundMessage:{_id:'inbound',body:'Can you help?'},result:{reply:'We can help.',decision:'reply',messageCategory:'service_request'}});
function harness(overrides={}) {
 const Message={updateOne:jest.fn().mockResolvedValue({}),findOne:jest.fn().mockResolvedValue(null),findByIdAndUpdate:jest.fn(),findOneAndUpdate:jest.fn(),findById:jest.fn(),create:jest.fn()};
 const sendSms=jest.fn().mockResolvedValue({sid:'SM1',status:'sent',body:'We can help.'});
 const AlertService={createSystemAlert:jest.fn().mockResolvedValue({})};
 const SocketService={emitMessageCreated:jest.fn(),emitConversationUpdated:jest.fn(),emitDashboardRefresh:jest.fn()};
 const Conversation={findByIdAndUpdate:jest.fn().mockResolvedValue({_id:'conv'})};
 const deps={Message,Conversation,AlertService,SocketService,sendSms,logOperationalEvent:jest.fn(),applySmsProductionInvariants:({result})=>result,describeSmsWorkflowDecision:()=>({type:'reply'}),assertDistributedLeaseActive:jest.fn(),respectCustomerConstraints:reply=>reply,getSmsAutomationSuppressionReason:jest.fn().mockResolvedValue(null),...overrides};
 return {deps,send:createSmsOutboundDelivery(deps)};
}
test('conversation message reader forwards the required tenant to the bounded AI history capability',async()=>{
 const db={getMessagesForAI:jest.fn().mockResolvedValue(['ai']),getMessagesByConversation:jest.fn()},model={};
 expect(await createSmsMessageReader({Db:db,Message:model})('conv','tenant')).toEqual(['ai']);
 expect(db.getMessagesForAI).toHaveBeenCalledWith(model,'conv','tenant');
 expect(db.getMessagesByConversation).not.toHaveBeenCalled();
 delete db.getMessagesForAI;
 await expect(createSmsMessageReader({Db:db,Message:model})('conv','tenant')).rejects.toThrow(TypeError);
 expect(db.getMessagesByConversation).not.toHaveBeenCalled();
});
test('no-reply decision records workflow and never contacts provider',async()=>{
 const {deps,send}=harness();
 expect(await send({...input(),result:{reply:'',decision:'no_reply'}})).toMatchObject({sent:false,reason:'no_reply'});
 expect(deps.Message.updateOne).toHaveBeenCalledTimes(1);
 expect(deps.sendSms).not.toHaveBeenCalled();
});
test('existing provider message is idempotently reused',async()=>{
 const {deps,send}=harness();
 deps.Message.findOne.mockResolvedValue({_id:'out',providerMessageId:'SM1'});
 expect(await send(input())).toMatchObject({sent:true,duplicate:true});
 expect(deps.sendSms).not.toHaveBeenCalled();
});
test('worker restart with uncertain delivery blocks duplicate provider send',async()=>{
 const {deps,send}=harness();
 deps.Message.findOne.mockResolvedValue({_id:'out',deliveryAttemptedAt:new Date(),providerMessageId:''});
 deps.Message.findByIdAndUpdate.mockResolvedValue({_id:'out'});
 expect(await send(input())).toMatchObject({sent:false,reason:'delivery_uncertain'});
 expect(deps.sendSms).not.toHaveBeenCalled();
 expect(deps.AlertService.createSystemAlert).toHaveBeenCalledTimes(1);
});
// The original provider write/claim/send/update order is especially important.
function pendingOutbound(deps) {
 const queued={_id:'out',providerMessageId:'',metadata:{source:'inbound_sms_reply'},deliveryAttemptedAt:null};
 deps.Message.create.mockResolvedValue(queued);
 deps.Message.findOneAndUpdate.mockResolvedValue({...queued,deliveryAttemptedAt:new Date()});
 deps.Message.findByIdAndUpdate.mockResolvedValue({...queued,status:'sent'});
}
test('successful send retains durable claim and socket side effects',async()=>{
 const {deps,send}=harness();pendingOutbound(deps);
 expect(await send(input())).toMatchObject({sent:true});
 expect(deps.Message.create).toHaveBeenCalledTimes(1);
 expect(deps.Message.findOneAndUpdate).toHaveBeenCalledTimes(1);
 expect(deps.sendSms).toHaveBeenCalledTimes(1);
 expect(deps.Message.findByIdAndUpdate).toHaveBeenCalledTimes(1);
 expect(deps.Conversation.findByIdAndUpdate).toHaveBeenCalledTimes(1);
 expect(deps.SocketService.emitConversationUpdated).toHaveBeenCalledTimes(1);
 expect(deps.SocketService.emitDashboardRefresh).toHaveBeenCalledTimes(1);
});
test('late opt-out suppression never contacts Twilio or updates conversation',async()=>{
 const {deps,send}=harness();pendingOutbound(deps);
 deps.getSmsAutomationSuppressionReason.mockResolvedValue('customer_opted_out');
 expect(await send(input())).toMatchObject({sent:false,suppressed:true,reason:'customer_opted_out'});
 expect(deps.Message.findOneAndUpdate).toHaveBeenCalledTimes(1);
 expect(deps.Message.findByIdAndUpdate).toHaveBeenCalledTimes(1);
 expect(deps.sendSms).not.toHaveBeenCalled();
 expect(deps.Conversation.findByIdAndUpdate).not.toHaveBeenCalled();
});
test('uncertain provider outcome never authorizes automatic resend',async()=>{
 const {deps,send}=harness();pendingOutbound(deps);
 deps.sendSms.mockRejectedValue(Object.assign(new Error('Twilio outcome unknown'),{code:'SMS_PROVIDER_OUTCOME_UNCERTAIN'}));
 expect(await send(input())).toMatchObject({sent:false,reason:'delivery_uncertain'});
 expect(deps.sendSms).toHaveBeenCalledTimes(1);
 expect(deps.AlertService.createSystemAlert).toHaveBeenCalledTimes(1);
 expect(deps.Conversation.findByIdAndUpdate).not.toHaveBeenCalled();
});
