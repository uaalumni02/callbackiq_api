import {stabilizationFixture} from '../setup/stabilizationFixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
import Alert from '../../src/models/alert.js';
import Policy from '../../src/models/schedulingPolicy.js';
import Delivery from '../../src/models/staffNotificationDelivery.js';
import {resolveStaffRecipients} from '../../src/services/notifications/recipientPolicy.service.js';
import {runStaffSms} from '../../src/services/staffSms.service.js';
let business,record,send;
beforeAll(connectTestDB,60000);
beforeEach(async()=>{
 process.env.CLIENT_URL='https://callbackiq.test';({business}=await stabilizationFixture());
 await Policy.create({business:business._id,staffSmsEnabled:true,staffSmsPhone:'+14045550111'});
 record=await Alert.create({business:business._id,type:'human_requested',title:'Synthetic request',message:'Synthetic review',priority:'high',actionRequired:true,dueAt:new Date(Date.now()+60000)});
 send=jest.fn().mockResolvedValue({sid:'SM-test'});
});
afterEach(async()=>{jest.restoreAllMocks();delete process.env.CLIENT_URL;delete process.env.STAFF_NOTIFICATION_SMS_ENABLED;await clearTestDB();});afterAll(closeTestDB);
test('owner texts use the opted-in destination and preserve review context without claiming acknowledgment',async()=>{
 await runStaffSms({send});expect(send).toHaveBeenCalledWith(expect.objectContaining({to:'+14045550111',source:'staff_request_notice',body:expect.stringContaining(`alertId=${record._id}`)}));
 const alert=await Alert.findById(record._id);expect(alert.metadata.staffSms.initial.state).toBe('sent');expect(alert.acknowledgedAt).toBeNull();expect((await Delivery.findOne({business:business._id}).lean()).providerMessageId).toBe('SM-test');
});
test.each(['acknowledged','opted_out','lost_claim'])('rechecks %s before sending',async reason=>{
 if(reason==='acknowledged')await Alert.updateOne({_id:record._id,business:business._id},{$set:{acknowledgedAt:new Date()}});
 if(reason==='opted_out')await Policy.updateOne({business:business._id},{$set:{staffSmsEnabled:false}});
 if(reason==='lost_claim'){const [recipient]=await resolveStaffRecipients({businessId:business._id,channel:'sms'});await Delivery.create({business:business._id,key:`alert:${record._id}:initial`,channel:'sms',recipientHash:recipient.hash,state:'sending',leaseUntil:new Date(Date.now()+120000)});}
 await runStaffSms({send});expect(send).not.toHaveBeenCalled();
});
test.each(['uncertain','failed','sent'])('initial %s outcome does not replay before the overdue stage',async state=>{
 await Alert.updateOne({_id:record._id,business:business._id},{$set:{'metadata.staffSms.initial':{state}}});await runStaffSms({send});expect(send).not.toHaveBeenCalled();
});
test('provider timeout remains uncertain',async()=>{send.mockRejectedValue(Object.assign(new Error('timeout'),{deliveryUncertain:true}));await runStaffSms({send});expect((await Alert.findById(record._id)).metadata.staffSms.initial.state).toBe('uncertain');await runStaffSms({send});expect(send).toHaveBeenCalledTimes(1);});
test('explicit server disable and absent owner opt-in perform no sends',async()=>{
 process.env.STAFF_NOTIFICATION_SMS_ENABLED='false';await runStaffSms({send});expect(await Delivery.countDocuments({business:business._id})).toBe(0);delete process.env.STAFF_NOTIFICATION_SMS_ENABLED;await Policy.deleteMany({business:business._id});await runStaffSms({send});expect(send).not.toHaveBeenCalled();
});
test('overdue notices use a distinct idempotency identity and exclude approval notifications',async()=>{
 await Alert.updateOne({_id:record._id,business:business._id},{$set:{'metadata.staffSms.initial':{state:'sent'},dueAt:new Date(Date.now()-1000)}});await runStaffSms({send});expect(send.mock.calls[0][0].metadata.idempotencyKey).toMatch(new RegExp(`^staff:${record._id}:overdue:`));
 await Alert.create({business:business._id,type:'human_requested',title:'Approval',message:'Synthetic approval',priority:'high',actionRequired:true,metadata:{approvalRequest:true}});await runStaffSms({send});expect(send).toHaveBeenCalledTimes(1);
});
