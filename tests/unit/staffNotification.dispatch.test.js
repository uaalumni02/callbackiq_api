import Job from '../../src/models/staffNotificationJob.js';
import Alert from '../../src/models/alert.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import { runStaffNotificationsOnce } from '../../src/services/staffNotification.service.js';
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertUpdated:jest.fn()}}));
const chain=value=>({sort:()=>chain(value),limit:()=>chain(value),select:()=>chain(value),lean:async()=>value});
const job={_id:'job',business:'business',alert:'alert',stage:'initial',attempts:1,revision:1};
beforeEach(()=>{
 process.env.STAFF_NOTIFICATION_EMAIL_ENABLED='true';
 jest.spyOn(Alert,'find').mockImplementation(()=>chain([]));
 jest.spyOn(Job,'find').mockImplementation(()=>chain([]));
 jest.spyOn(Job,'findOneAndUpdate').mockResolvedValueOnce(job).mockResolvedValue(null);
 jest.spyOn(Job,'findById').mockImplementation(()=>chain({...job,status:'accepted'}));
 jest.spyOn(Job,'updateOne').mockResolvedValue({modifiedCount:1});
 jest.spyOn(Alert,'findOneAndUpdate').mockResolvedValue(null);
 jest.spyOn(Alert,'findOne').mockImplementation(()=>chain({_id:'alert'}));
 jest.spyOn(Alert,'exists').mockResolvedValue({_id:'alert'});
 jest.spyOn(Business,'findOne').mockImplementation(()=>chain({owner:'owner',businessName:'Test'}));
 jest.spyOn(User,'findById').mockImplementation(()=>chain({email:'owner@example.test',emailVerifiedAt:new Date()}));
});
afterEach(()=>{jest.restoreAllMocks();delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;});
const completion=()=>Job.updateOne.mock.calls.find(([filter])=>filter.status==='sending')[1].$set;
test('successful provider acceptance does not mark staff acknowledgment',async()=>{
 const send=jest.fn().mockResolvedValue({accepted:['owner@example.test'],messageId:'provider-id'});
 await runStaffNotificationsOnce({send});expect(completion()).toMatchObject({status:'accepted',providerMessageId:'provider-id'});
 expect(send).toHaveBeenCalledWith(expect.objectContaining({email:'owner@example.test',alertId:'alert'}));
 expect(Alert.findOneAndUpdate.mock.calls.every(([,change])=>!change.$set.acknowledgedAt)).toBe(true);
});
test('ambiguous timeout never goes back to the automatic retry queue',async()=>{
 const send=jest.fn().mockRejectedValue(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}));
 await runStaffNotificationsOnce({send});expect(completion().status).toBe('uncertain');
});
test('known connection refusal may retry with a future deadline',async()=>{
 const send=jest.fn().mockRejectedValue(Object.assign(new Error('refused'),{code:'ECONNREFUSED'}));
 await runStaffNotificationsOnce({send});expect(completion().status).toBe('pending');expect(completion().nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
});
test('unverified owner email is never used as a notification recipient',async()=>{
 User.findById.mockImplementation(()=>chain({email:'owner@example.test'}));const send=jest.fn();
 await runStaffNotificationsOnce({send});expect(send).not.toHaveBeenCalled();expect(completion().lastError).toBe('VERIFIED_OWNER_EMAIL_REQUIRED');
});
test('acknowledgment before dispatch cancels the notification',async()=>{
 Alert.exists.mockResolvedValue(null);const send=jest.fn();await runStaffNotificationsOnce({send});expect(send).not.toHaveBeenCalled();expect(completion().status).toBe('canceled');
});
test('notifications remain disabled until explicitly configured',async()=>{
 delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;const send=jest.fn();expect(await runStaffNotificationsOnce({send})).toMatchObject({disabled:true});expect(send).not.toHaveBeenCalled();expect(Job.findOneAndUpdate).not.toHaveBeenCalled();
});
