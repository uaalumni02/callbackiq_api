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
