import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import CallLog from '../../src/models/callLog.js';
import { processTwilioCallStatus } from '../../src/services/twilioCallStatus.service.js';
import { recordCallAnswer } from '../../src/services/callAnswerEvidence.service.js';
import Alert from '../../src/models/alert.js';
import AlertService from '../../src/services/alert.service.js';
import { escalateOverdueInterventions } from '../../src/services/interventionEscalation.service.js';
// Model references are registered for population; no business/provider doubles.
import '../../src/models/business.js';
import '../../src/models/lead.js';
import '../../src/models/conversation.js';
let mongo;
const business = new mongoose.Types.ObjectId();
beforeAll(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await Promise.all([CallLog.init(),Alert.init()]);});
afterEach(async()=>{if(mongoose.connection.readyState===1) await Promise.all([CallLog.deleteMany({}),Alert.deleteMany({})]);});
afterAll(async()=>{await mongoose.disconnect();await mongo?.stop();});
test('completed callbacks cannot convert a missed recovery or AI answer to a staff answer',async()=>{
 const call=await CallLog.create({business,from:'+14045550100',to:'+14045550199',providerCallId:'CA'+'3'.repeat(32),status:'missed',disposition:'missed'});
 const send=CallStatus=>processTwilioCallStatus({businessId:business,payload:{CallSid:call.providerCallId,CallStatus}});
 await Promise.all([send('completed'),send('completed')]);
 expect((await CallLog.findById(call._id)).status).toBe('missed');
 await recordCallAnswer({businessId:business,callLogId:call._id,answeredBy:'ai'});
 await send('no-answer');
 expect((await CallLog.findById(call._id)).disposition).toBe('answered_by_ai');
 await recordCallAnswer({businessId:business,callLogId:call._id,answeredBy:'business'});
 await Promise.all([send('failed'),send('completed'),recordCallAnswer({businessId:business,callLogId:call._id,answeredBy:'ai'})]);
 expect(await CallLog.findById(call._id)).toMatchObject({status:'answered',disposition:'answered_by_business'});
});
test('replayed safety alerts dedupe, overdue review escalates once, and acknowledgment stops escalation',async()=>{
 const input={businessId:business,providerMessageId:'SM1',priority:'critical',messageBody:'Panel sparking'};
 await Promise.all([AlertService.createCustomerReplyAlert(input),AlertService.createCustomerReplyAlert(input)]);
 expect(await Alert.countDocuments({business})).toBe(1);
 await Alert.updateOne({business},{$set:{dueAt:new Date(Date.now()-60000)}});
 const results=await Promise.all([escalateOverdueInterventions(),escalateOverdueInterventions()]);
 expect(results.reduce((sum,r)=>sum+r.escalated,0)).toBe(1);
 await Alert.updateOne({business},{$set:{acknowledgedAt:new Date()},$unset:{'metadata.reviewEscalatedAt':''}});
 expect(await escalateOverdueInterventions()).toEqual({escalated:0});
});
