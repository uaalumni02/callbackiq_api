import Job from '../../src/models/staffNotificationJob.js';
import Alert from '../../src/models/alert.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import { runStaffNotificationsOnce, enqueueStaffNotifications } from '../../src/services/staffNotification.service.js';
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

test.each([null, {}, {accepted:[]}])('missing provider acceptance remains uncertain: %p',async result=>{
 await runStaffNotificationsOnce({send:jest.fn().mockResolvedValue(result)});expect(completion()).toMatchObject({status:'uncertain',lastError:'PROVIDER_ACCEPTANCE_UNVERIFIED'});
});
test.each(['alert','business','owner'])('missing %s cannot trigger email',async missing=>{
 if(missing==='alert')Alert.findOne.mockImplementation(()=>chain(null));
 if(missing==='business')Business.findOne.mockImplementation(()=>chain(null));
 if(missing==='owner')User.findById.mockImplementation(()=>chain(null));
 const send=jest.fn();await runStaffNotificationsOnce({send});expect(send).not.toHaveBeenCalled();
 expect(completion().status).toBe(missing==='owner'?'pending':'canceled');
});
test.each(['EAUTH',null])('last attempt handles provider error %p without unbounded retries',async code=>{
 Job.findOneAndUpdate.mockReset().mockResolvedValueOnce({...job,attempts:3}).mockResolvedValue(null);
 await runStaffNotificationsOnce({send:jest.fn().mockRejectedValue(Object.assign(new Error('failure'),code?{code}:{}))});
 expect(completion().status).toBe(code?'failed':'uncertain');
});
test('unverified recipient exhausts its retry budget',async()=>{
 Job.findOneAndUpdate.mockReset().mockResolvedValueOnce({...job,attempts:3}).mockResolvedValue(null);
 User.findById.mockImplementation(()=>chain({email:'owner@example.test'}));await runStaffNotificationsOnce({send:jest.fn()});expect(completion().status).toBe('failed');
});
test('lost completion fence does not publish another worker result',async()=>{
 Job.updateOne.mockResolvedValue({modifiedCount:0});await runStaffNotificationsOnce({send:jest.fn().mockResolvedValue({accepted:['owner@example.test']})});expect(Job.findById).not.toHaveBeenCalled();
});
test('unpublished state repairs emit the authoritative alert; deleted jobs are tolerated',async()=>{
 Job.find.mockImplementationOnce(()=>chain([job])).mockImplementationOnce(()=>chain([]));
 Alert.findOneAndUpdate.mockResolvedValue({_id:'alert'});
 await runStaffNotificationsOnce({send:jest.fn().mockResolvedValue({accepted:['owner@example.test']})});
 expect(require('../../src/services/socket.service.js').default.emitAlertUpdated).toHaveBeenCalledWith('business',{_id:'alert'});
 Job.findById.mockImplementation(()=>chain(null));Job.find.mockImplementationOnce(()=>chain([job])).mockImplementationOnce(()=>chain([]));await runStaffNotificationsOnce({send:jest.fn()});
});
test.each([0,1])('abandoned SMTP claims are marked uncertain with a fenced update: %s',async modifiedCount=>{
 Job.find.mockImplementationOnce(()=>chain([])).mockImplementationOnce(()=>chain([{...job,leaseToken:'old'}]));
 Job.findOneAndUpdate.mockReset().mockResolvedValue(null);Job.updateOne.mockResolvedValue({modifiedCount});
 const send=jest.fn();await runStaffNotificationsOnce({send});expect(send).not.toHaveBeenCalled();
 expect(Job.updateOne).toHaveBeenCalledWith(expect.objectContaining({leaseToken:'old',status:'sending'}),expect.objectContaining({$set:expect.objectContaining({status:'uncertain'})}));
 expect(Job.findById.mock.calls.length).toBe(modifiedCount);
});
test.each([null,11000,42])('enqueue handles successful insert, duplicate race and database error: %p',async code=>{
 Alert.find.mockImplementationOnce(()=>chain([{_id:'alert',business:'business'}])).mockImplementation(()=>chain([]));
 Job.findOneAndUpdate.mockReset();
 jest.spyOn(Job,'findOne').mockResolvedValue(job);
 if(code)Job.findOneAndUpdate.mockRejectedValue(Object.assign(new Error('insert'),{code}));else Job.findOneAndUpdate.mockResolvedValue(job);
 if(code===42)await expect(enqueueStaffNotifications()).rejects.toThrow('insert');
 else {await enqueueStaffNotifications();expect(Job.findById).toHaveBeenCalledWith('job');}
});
test('disabled enqueue does not query or claim',async()=>{delete process.env.STAFF_NOTIFICATION_EMAIL_ENABLED;await enqueueStaffNotifications();expect(Alert.find).not.toHaveBeenCalled();});
