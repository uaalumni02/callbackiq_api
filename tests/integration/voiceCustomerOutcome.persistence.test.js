import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import VoiceSession from '../../src/models/voiceSession.js';
import Alert from '../../src/models/alert.js';
import ProductionOperationLease from '../../src/models/productionOperationLease.js';
import VoiceCallback from '../../src/voice/voiceCallback.service.js';
import {processVoiceSafetyReview} from '../../src/services/voiceSafetyReview.service.js';
// Delivery is isolated; all request/session/alert records and leases use MongoDB.
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:new Proxy({},{get:()=>jest.fn()})}));
jest.mock('../../src/services/twilioSmsService.js',()=>({sendSms:jest.fn(()=>{throw new Error('Unexpected external SMS');})}));
jest.setTimeout(120000);
let mongo,business,lead,conversation,session;
beforeAll(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await Promise.all([Business,Lead,Conversation,VoiceSession,Alert,ProductionOperationLease].map(m=>m.init()));});
afterAll(async()=>{await mongoose.disconnect();if(mongo)await mongo.stop();});
beforeEach(async()=>{
 for(const c of Object.values(mongoose.connection.collections))await c.deleteMany({});
 business=await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'Voice Outcome Test',businessType:'plumbing',phone:'+14045550100',forwardingPhone:'+14045550101',isActive:true,features:{missedCallSmsEnabled:false}});
 lead=await Lead.create({business:business._id,phone:'+14045550199',serviceNeeded:'Bathroom sink replacement',address:'123 Main St Atlanta GA 30324',preferredAppointmentTime:'Friday at 10 AM'});
 conversation=await Conversation.create({business:business._id,lead:lead._id,customerPhone:lead.phone});
 session=await VoiceSession.create({business:business._id,lead:lead._id,conversation:conversation._id,providerCallSid:'CA-outcome-test',from:lead.phone,to:business.phone,status:'active'});
});
const reload=()=>VoiceSession.findById(session._id).populate('business lead conversation');
const submit=async()=>VoiceCallback.handle({session:await reload(),customerMessage:'Please call me',reason:'customer_requested_human',requiredFields:[],immediate:true,sendConfirmationSms:false});
test('callback survives document reload and replay without duplicate alerts or confirmation',async()=>{
 const result=await submit();expect(result.callbackCaptured).toBe(true);
 for(let attempt=0;attempt<2;attempt++){
  if(attempt)await submit();
  const saved=await reload();
  expect(saved.lead.serviceNeeded).toBe('Bathroom sink replacement');
  expect(saved.lead.preferredAppointmentTime).toBe('Friday at 10 AM');
  // Request acknowledgment is separate from actual staff acceptance.
  expect(saved.conversation.orchestration.handoffStatus).toBe('acknowledged');
  expect(saved.conversation.orchestration.phase).toBe('handoff_pending');
  expect(saved.conversation.humanTakeover).toBe(false);
  expect(saved.conversation.aiEnabled).toBe(true);
  expect(saved.metadata.callbackCapture.completedAt).toBeTruthy();
  expect(saved.conversation.bookingState.status).not.toBe('booked');
  const alerts=await Alert.find({business:business._id,conversation:conversation._id});
  expect(alerts).toHaveLength(1);
  expect(alerts[0].actionRequired).toBe(true);
  expect(alerts[0].status).toBe('pending');
  expect(alerts[0].acknowledgedAt).toBeNull();
  expect(alerts[0].acknowledgedBy).toBeNull();
  expect(alerts[0].assignedTo).toBeNull();
 }
});
test('safety worker persists urgency and one actionable alert across retries during staff ownership',async()=>{
 await Conversation.updateOne({_id:conversation._id},{$set:{humanTakeover:true,aiEnabled:false}});
 const payload={businessId:business._id,conversationId:conversation._id,sessionId:session._id,eventId:'safety-replay-test',observedAt:new Date().toISOString(),assessment:{category:'emergency',reason:'safety_emergency',hazardType:'gas'},customerMessage:'I smell gas'};
 await processVoiceSafetyReview(payload);await processVoiceSafetyReview(payload);
 const saved=await reload();const alerts=await Alert.find({business:business._id,dedupeKey:'voice-safety:safety-replay-test'});
 expect(alerts).toHaveLength(1);expect(alerts[0].priority).toBe('critical');expect(alerts[0].actionRequired).toBe(true);expect(saved.lead.urgency).toBe('emergency');expect(saved.conversation.humanTakeover).toBe(true);expect(saved.lead.preferredAppointmentTime).toBe('Friday at 10 AM');
});

test('callback partial facts survive session reload and final alert uses exact corrected fields', async () => {
 await Lead.updateOne({_id:lead._id},{$set:{customerName:'Voice Caller',serviceNeeded:'Unknown',address:'',preferredAppointmentTime:''}});
 const turn=async text=>VoiceCallback.handle({session:await reload(),customerMessage:text,sendConfirmationSms:false});
 await turn('I need drain cleaning');
 await turn('Actually I need my kitchen faucet replaced');
 await turn('970 Sidney Marcus Atlanta GA 30324');
 await turn('Friday at 10 am');
 let saved=await reload();
 expect(saved.lead.serviceNeeded).toBe('my kitchen faucet replaced');
 expect(saved.lead.customerName).toBe('Voice Caller');
 expect(saved.lead.address).toBe('970 Sidney Marcus Atlanta GA 30324');
 expect(saved.lead.preferredAppointmentTime).toBe('Friday at 10 am');
 expect(await Alert.countDocuments({conversation:conversation._id})).toBe(0);
 await turn('Pat Smith');
 await turn('Actually my ZIP is 30326');
 expect((await turn('yes')).callbackCaptured).toBe(true);
 saved=await reload();
 expect(saved.lead.address).toBe('970 Sidney Marcus Atlanta GA 30326');
 const alert=await Alert.findOne({conversation:conversation._id});
 expect(alert.metadata.callbackDetails).toMatchObject({serviceNeeded:'my kitchen faucet replaced',customerName:'Pat Smith',location:'970 Sidney Marcus Atlanta GA 30326',preferredTime:'Friday at 10 am'});
});

test('separate durable writer invalidates a stale callback readback after reload', async () => {
 await Lead.updateOne({_id:lead._id},{$set:{customerName:'Pat Smith'}});
 const turn=async text=>VoiceCallback.handle({session:await reload(),customerMessage:text,sendConfirmationSms:false});
 await turn('Please call me');
 await Lead.updateOne({_id:lead._id},{$set:{serviceNeeded:'Furnace repair',address:'456 Oak St Atlanta GA 30326'}});
 expect((await turn('yes')).callbackCaptured).toBe(false);
 expect(await Alert.countDocuments({conversation:conversation._id})).toBe(0);
 expect((await turn('yes')).callbackCaptured).toBe(true);
 const saved=await reload();
 expect(saved.lead.serviceNeeded).toBe('Furnace repair');
 expect(saved.lead.address).toBe('456 Oak St Atlanta GA 30326');
});

describe.each([['sms', false], ['voice', false], ['sms', true], ['voice', true]])('%s intake survives document reload (booking=%s)', (channel, aiBookingEnabled) => {
 test.each([['When I use it', 'during_use'], ['Leaking now', 'active']])('service → %s → address retains exact facts', async (answer, leakPattern) => {
  const { default: ServiceOffering } = await import('../../src/models/serviceOffering.js');
  const { default: ServiceArea } = await import('../../src/models/serviceArea.js');
  const { default: Operations } = await import('../../src/models/businessOperationsSettings.js');
  const { handleRecoveryIntake } = await import('../../src/services/booking/recoveryIntake.service.js');
  await ServiceOffering.create({ business: business._id, name: 'Sink repair', nameKey: 'sink repair', category: 'plumbing', active: true, aiCanBook: true, aiCanDiscuss: true });
  await Operations.create({ business: business._id, serviceEligibilityPolicy: { catalogComplete: true } });
  await ServiceArea.create({ business: business._id, type: 'zip_codes', zipCodes: ['30324'] });
  await Business.updateOne({ _id: business._id }, { $set: { 'features.aiBookingEnabled': aiBookingEnabled } });
  await Lead.updateOne({ _id: lead._id }, { $set: { serviceNeeded: 'Unknown', address: '', preferredAppointmentTime: '' } });
  const turn = async (customerMessage, turnId) => {
   const saved = await reload();
   return handleRecoveryIntake({ business: saved.business, lead: saved.lead, conversation: saved.conversation, channel, customerMessage, turnId });
  };
  expect((await turn('My kitchen sink pipes are leaking', 'first')).reply).toMatch(/leaking right now/);
  expect((await turn(answer, 'second')).reply).toMatch(/service address/);
  let saved = await reload();
  expect(saved.conversation.conversationMemory.recoveryIntake).toMatchObject({ triageResolved: true, leakPattern, triageAnswer: answer });
  expect(saved.lead.address).toBe('');
  expect(await Alert.countDocuments({ conversation: conversation._id })).toBe(0);
  expect((await turn('123 Main Street Atlanta GA 30324', 'third')).reply).toMatch(/what day/i);
  saved = await reload();
  expect(saved.lead.address).toBe('123 Main Street Atlanta GA 30324');
  expect(saved.lead.serviceNeeded).toMatch(/kitchen sink/);
  expect(saved.conversation.conversationMemory.recoveryIntake.coverage.supported).toBe(true);
  expect(saved.conversation.bookingState.appointment).toBeFalsy();
 });
});

test('service review is durable without YES and repeated replies do not duplicate the alert', async () => {
 const { default: Operations } = await import('../../src/models/businessOperationsSettings.js');
 const { guardServiceRequest } = await import('../../src/services/serviceEligibility/serviceEligibility.service.js');
 await Operations.create({ business: business._id, serviceEligibilityPolicy: { catalogComplete: false } });
 await Lead.updateOne({ _id: lead._id }, { $set: { serviceNeeded: 'Unknown', address: '' } });
 const turn = async (customerMessage, turnId) => {
  const saved = await reload();
  return guardServiceRequest({ business: saved.business, lead: saved.lead, conversation: saved.conversation, customerMessage, turnId });
 };
 expect((await turn('I need roof repair', 'one')).reply).toMatch(/saved for staff/);
 expect(await Alert.countDocuments({ conversation: conversation._id })).toBe(1);
 await turn('yes', 'two');
 expect((await turn('I can explain it to the team', 'three')).reply).not.toMatch(/can't verify|what is the service address/i);
 await turn('123 Main Street Atlanta GA 30324', 'four');
 const saved = await reload();
 expect(saved.lead.address).toContain('30324');
 expect(saved.lead.serviceNeeded).toMatch(/roof repair/);
 expect(saved.conversation.serviceEligibility.reviewSubmitted).toBe(true);
 expect(await Alert.countDocuments({ conversation: conversation._id })).toBe(1);
});
