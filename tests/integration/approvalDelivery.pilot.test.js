import mongoose from 'mongoose';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
import {stabilizationFixture} from '../setup/stabilizationFixture.js';
import Alert from '../../src/models/alert.js';
import Policy from '../../src/models/schedulingPolicy.js';
import Delivery from '../../src/models/staffNotificationDelivery.js';
import {runApprovalSms} from '../../src/services/scheduling/approvalSms.service.js';
import {resolveStaffRecipients} from '../../src/services/notifications/recipientPolicy.service.js';
let business,alert,send;
beforeAll(connectTestDB,60000);beforeEach(async()=>{
 ({business}=await stabilizationFixture());process.env.STAFF_APPROVAL_SMS_ENABLED='true';process.env.CLIENT_URL='https://app.example.com';
 await Policy.create({business:business._id,approvalSmsEnabled:true,approvalSmsPhone:'+14045550101'});
 alert=await Alert.create({business:business._id,appointment:new mongoose.Types.ObjectId(),type:'human_requested',title:'Synthetic approval',message:'Synthetic request',priority:'medium',actionRequired:true,dueAt:new Date(Date.now()+3600000),metadata:{approvalRequest:true,approvalState:'pending'}});
 send=jest.fn(async()=>({sid:'SM-test'}));
});afterEach(async()=>{delete process.env.STAFF_APPROVAL_SMS_ENABLED;delete process.env.CLIENT_URL;await clearTestDB();});afterAll(closeTestDB);
test('staff approval SMS remains globally off unless deliberately enabled',async()=>{
 delete process.env.STAFF_APPROVAL_SMS_ENABLED;expect(await runApprovalSms({send})).toMatchObject({disabled:true});expect(send).not.toHaveBeenCalled();expect(await Delivery.countDocuments({business:business._id})).toBe(0);
});
test('approval text uses authenticated review links and a stable recipient-specific identity without customer PII',async()=>{
 expect(await runApprovalSms({send})).toMatchObject({sent:1});expect(send).toHaveBeenCalledWith(expect.objectContaining({to:'+14045550101',source:'staff_approval_notice',body:expect.stringContaining(`/appointments?appointmentId=${alert.appointment}`),metadata:{idempotencyKey:expect.stringMatching(new RegExp(`^staff:${alert._id}:initial:`))}}));expect(send.mock.calls[0][0].body).not.toMatch(/125 Main|Sarah|reply 1/i);
});
test('a durable atomic claim prevents concurrent senders duplicating an approval text',async()=>{await Promise.all(Array.from({length:4},()=>runApprovalSms({send})));expect(send).toHaveBeenCalledTimes(1);});
test('a delivered stage is never sent twice',async()=>{await runApprovalSms({send});await runApprovalSms({send});expect(send).toHaveBeenCalledTimes(1);});
test('safe quiet-hour suppression schedules a future retry without immediately dispatching again',async()=>{
 send.mockResolvedValue({suppressed:true,reason:'outside_send_window'});await runApprovalSms({send});const row=await Delivery.findOne({business:business._id});expect(row.state).toBe('blocked');expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());await runApprovalSms({send});expect(send).toHaveBeenCalledTimes(1);
});
test('an interrupted sending claim becomes uncertain without being resent',async()=>{
 const [recipient]=await resolveStaffRecipients({businessId:business._id,channel:'sms',approval:true});await Delivery.create({business:business._id,key:`alert:${alert._id}:initial`,channel:'sms',recipientHash:recipient.hash,state:'sending',leaseUntil:new Date(Date.now()-1000)});await runApprovalSms({send});expect(send).not.toHaveBeenCalled();expect((await Delivery.findOne({business:business._id})).state).toBe('uncertain');
});
test('an expired reservation notice explicitly requires a fresh availability recheck',async()=>{
 await Alert.updateOne({_id:alert._id,business:business._id},{$set:{'metadata.approvalState':'needs_recheck'}});await runApprovalSms({send});expect(send.mock.calls[0][0].body).toContain('reservation expired');expect(send.mock.calls[0][0].body).toContain('availability recheck');expect(send.mock.calls[0][0].metadata.idempotencyKey).toMatch(new RegExp(`^staff:${alert._id}:expired:`));
});
