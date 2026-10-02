import Alert from '../../src/models/alert.js';
import Business from '../../src/models/business.js';
import Policy from '../../src/models/schedulingPolicy.js';
import { runStaffSms } from '../../src/services/staffSms.service.js';
const chain = result => ({sort:()=>chain(result),limit:()=>chain(result),lean:async()=>result});
let record, send;
beforeEach(()=>{
 process.env.CLIENT_URL='https://callbackiq.test';
 record={_id:'alert',business:'business',lead:'lead',priority:'critical',metadata:{},dueAt:new Date(Date.now()+60000)};
 jest.spyOn(Policy,'find').mockImplementation(()=>chain([{business:'business',staffSmsPhone:'+14045550111'}]));
 jest.spyOn(Policy,'exists').mockResolvedValue({_id:'policy'});
 jest.spyOn(Business,'findOne').mockResolvedValue({_id:'business'});
 jest.spyOn(Alert,'find').mockImplementation(()=>chain([record]));
 jest.spyOn(Alert,'exists').mockResolvedValue({_id:'alert'});
 jest.spyOn(Alert,'findOneAndUpdate').mockResolvedValue(record);
 jest.spyOn(Alert,'updateOne').mockResolvedValue({modifiedCount:1});
 send=jest.fn().mockResolvedValue({sid:'SM-test'});
});
afterEach(()=>{jest.restoreAllMocks();delete process.env.CLIENT_URL;delete process.env.STAFF_NOTIFICATION_SMS_ENABLED;});
test('owner texts use the opted-in destination and preserve review context without claiming acknowledgment',async()=>{
 await runStaffSms({send});expect(send).toHaveBeenCalledWith(expect.objectContaining({to:'+14045550111',source:'staff_request_notice',body:expect.stringContaining('leadId=lead')}));
 expect(Alert.updateOne.mock.calls[0][1].$set['metadata.staffSms.initial']).toMatchObject({state:'sent',providerMessageId:'SM-test'});
 expect(Alert.updateOne.mock.calls.every(([,update])=>!('acknowledgedAt' in update.$set))).toBe(true);
});
test.each(['acknowledged','opted_out','lost_claim'])('rechecks %s before sending',async reason=>{
 if(reason==='acknowledged')Alert.exists.mockResolvedValue(null);
 if(reason==='opted_out')Policy.exists.mockResolvedValue(null);
 if(reason==='lost_claim')Alert.findOneAndUpdate.mockResolvedValue(null);
 await runStaffSms({send});expect(send).not.toHaveBeenCalled();
});
test.each(['uncertain','failed','sent'])('initial %s outcome does not replay before the overdue stage',async state=>{
 record.metadata.staffSms={initial:{state}};await runStaffSms({send});expect(send).not.toHaveBeenCalled();
});
test('provider timeout remains uncertain',async()=>{
 send.mockRejectedValue(Object.assign(new Error('timeout'),{deliveryUncertain:true}));
 await runStaffSms({send});expect(Alert.updateOne.mock.calls[0][1].$set['metadata.staffSms.initial'].state).toBe('uncertain');
});
test('explicit server disable and absent owner opt-in perform no sends',async()=>{
 process.env.STAFF_NOTIFICATION_SMS_ENABLED='false';await runStaffSms({send});expect(Policy.find).not.toHaveBeenCalled();
 delete process.env.STAFF_NOTIFICATION_SMS_ENABLED;Policy.find.mockImplementation(()=>chain([]));await runStaffSms({send});expect(send).not.toHaveBeenCalled();
});
test('overdue notices use a distinct idempotency identity and exclude approval notifications',async()=>{
 record.metadata.staffSms={initial:{state:'sent'}};record.dueAt=new Date(Date.now()-1000);
 await runStaffSms({send});expect(send.mock.calls[0][0].metadata.idempotencyKey).toBe('staff-request:alert:overdue');
 expect(Alert.find.mock.calls[0][0]).toMatchObject({'metadata.approvalRequest':{$ne:true},actionRequired:true,acknowledgedAt:null,resolvedAt:null});
});
