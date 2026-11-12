import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../src/app.js';
import Token from '../../src/helpers/jwt/token.js';
import User from '../../src/models/user.js';
import Subscription from '../../src/models/subscription.js';
import Appointment from '../../src/models/appointment.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import CallLog from '../../src/models/callLog.js';
import ManualOperation from '../../src/models/manualSmsOperation.js';
import Disclosure from '../../src/models/smsContactDisclosure.js';
import VoiceReconciliation from '../../src/models/voiceUsageReconciliation.js';
import ConnectionBucket from '../../src/models/voiceConnectionBucket.js';
import {acquireVoiceConnectionLease,releaseVoiceConnectionLease} from '../../src/services/voiceConnectionLease.service.js';
import {processTwilioMessageStatus} from '../../src/services/messaging/smsDeliveryStatus.service.js';
import {processTwilioCallStatus} from '../../src/services/twilioCallStatus.service.js';
import {claimSmsContactDisclosure,releaseSmsContactDisclosure,commitSmsContactDisclosure} from '../../src/services/smsContactDisclosure.service.js';
import {reconcileVoiceUsage,listVoiceUsageReconciliationCandidates} from '../../src/services/voiceUsage.service.js';
import {resolveBusinessForTwilioStatus} from '../../src/services/twilioStatusBusinessResolver.service.js';
import {executeManualSmsOperation} from '../../src/services/messaging/manualSmsOperation.service.js';
import {sendSms} from '../../src/services/twilioSmsService.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testReplicaDb.js';
jest.mock('../../src/services/twilioSmsService.js',()=>({sendSms:jest.fn()}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitMessageCreated:jest.fn(),emitMessageUpdated:jest.fn(),emitCallUpdated:jest.fn(),emitConversationUpdated:jest.fn(),emitDashboardRefresh:jest.fn()}}));
const oid=()=>new mongoose.Types.ObjectId();
let business,conversation;
beforeAll(connectTestDB,60000);afterEach(async()=>{jest.clearAllMocks();await clearTestDB()});afterAll(closeTestDB);
beforeEach(async()=>{
 business=await Business.create({owner:oid(),businessName:'Synthetic contract plumbing',businessType:'plumbing',phone:'+14045550110',forwardingPhone:'+14045550111'});
 conversation=await Conversation.create({business:business._id,customerPhone:'+14045550112',status:'open',aiEnabled:true,humanTakeover:false});
});
test('appointment approval requires authentication, entitlement and ownership at the HTTP boundary',async()=>{
 const appointmentId=oid(),foreignBusiness=oid();
 await Appointment.collection.insertOne({_id:appointmentId,business:foreignBusiness,status:'held'});
 const endpoint=`/api/appointments/${appointmentId}/confirm`;
 expect((await request(app).post(endpoint).send({})).status).toBe(401);
 await User.create({_id:business.owner,userName:'contractowner',email:'contractowner@example.test',password:'SyntheticPassword123',role:'owner',businessName:'Synthetic contract plumbing'});
 const token=Token.sign({userId:String(business.owner),role:'owner'});
 const denied=await request(app).post(endpoint).set('Authorization',`Bearer ${token}`).send({});
 expect(denied.status).toBe(403);
 await Subscription.create({business:business._id,status:'active',isActive:true,currentPeriodEnd:new Date('2099-01-01')});
 const foreign=await request(app).post(endpoint).set('Authorization',`Bearer ${token}`).send({});
 expect(foreign.status).toBe(404);expect((await Appointment.findById(appointmentId)).status).toBe('held');
 expect(sendSms).not.toHaveBeenCalled();
});
test('concurrent first-contact senders cannot release the winning disclosure claim',async()=>{
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='development';
 try{
  const input={businessId:business._id,phone:conversation.customerPhone,source:'manual_sms'};
  const results=await Promise.all([claimSmsContactDisclosure({...input,operationKey:'first'}),claimSmsContactDisclosure({...input,operationKey:'second'})]);
  const winners=results.filter(row=>row.claim);expect(winners).toHaveLength(1);
  const concurrent=results.find(row=>!row.claim);expect(concurrent).toMatchObject({concurrent:true,append:true});
  await releaseSmsContactDisclosure({claim:concurrent.claim});expect(await Disclosure.countDocuments()).toBe(1);
  const stored=await Disclosure.findOne({business:business._id});expect(stored.ownerToken).toBe(winners[0].claim.ownerToken);
  await commitSmsContactDisclosure({...input,claim:winners[0].claim,providerMessageId:'SM_disclosure'});
  expect((await claimSmsContactDisclosure(input)).append).toBe(false);
 }finally{process.env.NODE_ENV=previous;}
});
test('voice reconciliation cannot steal a processing row with an unexpired owner lease',async()=>{
 const now=new Date(),session=oid();
 const row=await VoiceReconciliation.create({business:business._id,session,state:'processing',ownerToken:'active-worker',attemptCount:1,
  leaseExpiresAt:new Date(+now+60000),purgeAt:new Date(+now+86400000)});
 expect(await listVoiceUsageReconciliationCandidates({now})).toHaveLength(0);
 expect(await reconcileVoiceUsage({businessId:business._id,sessionId:session,actualSeconds:30,now})).toMatchObject({reconciled:false,pending:true,replayed:true});
 expect(await VoiceReconciliation.findById(row._id)).toMatchObject({state:'processing',ownerToken:'active-worker',attemptCount:1,actualSeconds:0});
});
test('status ownership follows stored provider identifiers, ignoring a foreign phone hint',async()=>{
 const other=await Business.create({owner:oid(),businessName:'Other contract tenant',businessType:'hvac',phone:'+14045550120',forwardingPhone:'+14045550121'});
 const message=await Message.create({business:business._id,conversation:conversation._id,direction:'outbound',body:'Synthetic contract message',from:business.phone,to:conversation.customerPhone,provider:'twilio',providerMessageId:'SM_contract',status:'queued'});
 await CallLog.collection.insertOne({business:business._id,providerCallId:'CA_contract'});
 expect(String((await resolveBusinessForTwilioStatus({MessageSid:message.providerMessageId,To:other.phone}))._id)).toBe(String(business._id));
 expect(String((await resolveBusinessForTwilioStatus({CallSid:'CA_contract',To:other.phone}))._id)).toBe(String(business._id));
 expect(await resolveBusinessForTwilioStatus({MessageSid:'SM_unknown',To:other.phone})).toBeNull();
});
test('late SMS and call callbacks cannot downgrade terminal durable outcomes',async()=>{
 const message=await Message.create({business:business._id,conversation:conversation._id,direction:'outbound',body:'Synthetic delivered message',
  from:business.phone,to:conversation.customerPhone,provider:'twilio',providerMessageId:'SM_delivered',status:'delivered',deliveryStatus:'delivered'});
 await CallLog.collection.insertOne({business:business._id,providerCallId:'CA_answered',status:'answered',disposition:'answered_by_business'});
 await processTwilioMessageStatus({businessId:business._id,payload:{MessageSid:'SM_delivered',MessageStatus:'queued'},skipReconciliationPersistence:true});
 await processTwilioCallStatus({businessId:business._id,payload:{CallSid:'CA_answered',CallStatus:'failed'}});
 expect(await Message.findById(message._id)).toMatchObject({status:'delivered',deliveryStatus:'delivered'});
 expect(await CallLog.findOne({providerCallId:'CA_answered'})).toMatchObject({status:'answered',disposition:'answered_by_business'});
});
test('separate connection attempts share one atomic MongoDB admission budget',async()=>{
 const results=await Promise.all([acquireVoiceConnectionLease({remoteAddress:'203.0.113.7',maximum:1}),
  acquireVoiceConnectionLease({remoteAddress:'203.0.113.7',maximum:1})]);
 expect(results.filter(row=>row.allowed)).toHaveLength(1);expect(results.filter(row=>!row.allowed)).toHaveLength(1);
 const winner=results.find(row=>row.allowed),bucket=await ConnectionBucket.findOne({ipHash:winner.ipHash});expect(bucket.leases).toHaveLength(1);
 await releaseVoiceConnectionLease({ipHash:winner.ipHash,leaseId:'not-the-owner'});
 expect((await ConnectionBucket.findById(bucket._id)).leases).toHaveLength(1);
 await releaseVoiceConnectionLease(winner.lease);expect((await ConnectionBucket.findById(bucket._id)).leases).toHaveLength(0);
});
test('manual SMS preserves the conversation until provider acceptance, then persists one message and takeover',async()=>{
 let accept,started;const dispatchStarted=new Promise(resolve=>{started=resolve});
 sendSms.mockImplementation(()=>{started();return new Promise(resolve=>{accept=resolve})});
 const input={business,conversationId:conversation._id,to:conversation.customerPhone,body:'The team will call you.',operationId:'manual-contract-1'};
 const pending=executeManualSmsOperation(input);await dispatchStarted;
 expect(await Conversation.findById(conversation._id)).toMatchObject({aiEnabled:true,humanTakeover:false});expect(await Message.countDocuments()).toBe(0);
 accept({sid:'SM_accepted',status:'queued'});expect(await pending).toMatchObject({accepted:true,completed:true});
 expect(await Conversation.findById(conversation._id)).toMatchObject({aiEnabled:false,humanTakeover:true});expect(await Message.countDocuments()).toBe(1);
 expect((await executeManualSmsOperation(input)).replayed).toBe(true);expect(sendSms).toHaveBeenCalledTimes(1);
});
test('an uncertain manual SMS outcome remains recoverable without fabricating a message or takeover',async()=>{
 sendSms.mockRejectedValue(Object.assign(new Error('Synthetic receipt uncertainty'),{code:'SMS_PROVIDER_OUTCOME_UNCERTAIN',deliveryUncertain:true}));
 await expect(executeManualSmsOperation({business,conversationId:conversation._id,to:conversation.customerPhone,
  body:'The team will call you.',operationId:'manual-uncertain'})).rejects.toMatchObject({reconciliationRequired:true});
 expect(await ManualOperation.findOne({operationId:'manual-uncertain'})).toMatchObject({state:'reconciliation_required'});
 expect(await Conversation.findById(conversation._id)).toMatchObject({aiEnabled:true,humanTakeover:false});expect(await Message.countDocuments()).toBe(0);
});
