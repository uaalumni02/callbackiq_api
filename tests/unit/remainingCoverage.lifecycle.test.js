jest.mock('../../src/services/staffReviewReconciliation.service.js',()=>({maintainStaffReviewRecords:jest.fn().mockResolvedValue({skipped:true})}));
jest.mock('../../src/services/serviceEligibility/policy.js',()=>({blocksServiceAutomation:jest.fn()}),{virtual:true});
jest.mock('../../src/workers/staffNotification.worker.js',()=>({startStaffNotificationWorker:jest.fn(),stopStaffNotificationWorker:jest.fn()}));
jest.mock('../../src/services/smsStaffReviewRecovery.service.js',()=>({recoverFailedSmsStaffReviews:jest.fn()}));
jest.mock('../../src/services/interventionEscalation.service.js',()=>({escalateOverdueInterventions:jest.fn()}));
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{find:jest.fn(),findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/models/message.js',()=>({__esModule:true,default:{findOne:jest.fn()}}));
jest.mock('../../src/services/distributedLease.service.js',()=>({withDistributedLease:jest.fn(async(key,fn)=>({acquired:true,value:await fn()}))}));
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import {blocksServiceAutomation} from '../../src/services/serviceEligibility/policy.js';
import {runConversationLifecycleOnce,startConversationLifecycleWorker,stopConversationLifecycleWorker} from '../../src/workers/conversationLifecycle.worker.js';
import {startStaffNotificationWorker,stopStaffNotificationWorker} from '../../src/workers/staffNotification.worker.js';
const oldEnabled=process.env.SMS_LIFECYCLE_WORKER_ENABLED;
afterEach(async()=>{await stopConversationLifecycleWorker();if(oldEnabled===undefined)delete process.env.SMS_LIFECYCLE_WORKER_ENABLED;else process.env.SMS_LIFECYCLE_WORKER_ENABLED=oldEnabled;});
test('scan survives one failed record, handles a disappeared record and uses fresh eligibility',async()=>{
 const candidates=[{_id:'failed'},{_id:'gone'},{_id:'blocked'}];const sort=jest.fn(()=>({limit:async()=>candidates}));Conversation.find.mockReturnValue({sort});
 Conversation.findOneAndUpdate.mockRejectedValueOnce(new Error('record unavailable')).mockResolvedValueOnce(null).mockResolvedValueOnce({_id:'blocked',status:'open',bookingState:{}});
 blocksServiceAutomation.mockReturnValue(true);
 const now=new Date('2026-09-12T12:00:00Z');const result=await runConversationLifecycleOnce({now});
 expect(result.outcomes).toMatchObject({failed:1,noop:2});
 expect(sort).toHaveBeenCalledWith({'lifecycle.lastScannedAt':1,_id:1});
 expect(Conversation.findOneAndUpdate).toHaveBeenCalledWith({_id:'blocked',status:'open'},{$set:{'lifecycle.lastScannedAt':now}},{returnDocument:'after'});
 expect(blocksServiceAutomation).toHaveBeenCalledWith(expect.objectContaining({_id:'blocked'}));expect(Message.findOne).not.toHaveBeenCalled();
});
test('staff notification shutdown is awaited even when lifecycle polling is disabled',async()=>{
 process.env.SMS_LIFECYCLE_WORKER_ENABLED='false';startConversationLifecycleWorker();expect(startStaffNotificationWorker).toHaveBeenCalled();
 let release;stopStaffNotificationWorker.mockImplementationOnce(()=>new Promise(r=>{release=r;}));let done=false;
 const stopping=stopConversationLifecycleWorker().then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);release();await stopping;expect(done).toBe(true);
});

 test.each([
 {humanTakeover:true,aiEnabled:false,humanTakeoverAt:null},
 {humanTakeover:true,aiEnabled:false,humanTakeoverAt:new Date('2026-09-01T12:00:00Z')},
 {humanTakeover:false,aiEnabled:false},
 ])('quiet staff-owned conversations never resume automatically: %j',async flags=>{
 jest.clearAllMocks();
 const conversation={_id:'owned',status:'open',lastMessageAt:new Date('2026-09-01T10:00:00Z'),...flags};
 Conversation.find.mockReturnValue({sort:()=>({limit:async()=>[conversation]})});
 Conversation.findOneAndUpdate.mockResolvedValue(conversation);
 const result=await runConversationLifecycleOnce({now:new Date('2026-09-30T23:55:00Z')});
 expect(result.outcomes).toEqual({noop:1});
 expect(Conversation.findOneAndUpdate).toHaveBeenCalledTimes(1);
 expect(Message.findOne).not.toHaveBeenCalled();
 });
