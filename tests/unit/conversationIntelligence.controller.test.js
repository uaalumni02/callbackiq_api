import '../../src/models/user.js';
// Controller contracts execute real authorization, claims and persistence.
// Only AI, valuation-provider work and socket delivery are replaced.
import mongoose from 'mongoose';
import Controller from '../../src/controllers/conversationIntelligence.js';
import Intelligence from '../../src/models/conversationIntelligence.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import Message from '../../src/models/message.js';
import Service from '../../src/services/conversationIntelligence.service.js';
import * as Valuation from '../../src/services/valuation/opportunityValuation.service.js';
import Socket from '../../src/services/socket.service.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
jest.mock('../../src/services/conversationIntelligence.service.js',()=>({__esModule:true,default:{analyze:jest.fn()}}));
jest.mock('../../src/services/valuation/opportunityValuation.service.js',()=>({beginValuation:jest.fn(),finishValuation:jest.fn()}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitToBusiness:jest.fn(),emitDashboardRefresh:jest.fn()}}));
let business,conversation,lead,req,res,analysis;
beforeAll(async()=>{await connectTestDB();await Intelligence.init();},60000);
beforeEach(async()=>{
 jest.clearAllMocks();jest.spyOn(console,'error').mockImplementation(()=>{});
 ({business}=await trackingFixture());
 lead=await Lead.create({business:business._id,customerName:'Synthetic customer',phone:'+14045550125',serviceNeeded:'Sink repair',urgency:'emergency'});
 conversation=await Conversation.create({business:business._id,lead:lead._id,customerPhone:lead.phone,lastMessage:'Sink repair'});
 await Message.create({business:business._id,conversation:conversation._id,lead:lead._id,direction:'inbound',from:lead.phone,to:business.phone,body:'Sink repair'});
 req={user:{userId:business.owner},params:{conversationId:String(conversation._id)},body:{force:true}};
 res={status:jest.fn().mockReturnThis(),json:jest.fn().mockReturnThis()};
 analysis={summary:'Repair request',customerIntent:{category:'repair',serviceType:'Sink'},buyingLikelihood:{score:50},urgency:{level:'normal'},nextBestAction:{actionType:'call_soon',completed:false,outcome:''}};
 Service.analyze.mockResolvedValue(analysis);
});
afterEach(async()=>{jest.restoreAllMocks();await clearTestDB();});afterAll(closeTestDB);
test('force cannot bypass an active persisted analysis claim',async()=>{
 await Intelligence.create({business:business._id,conversation:conversation._id,status:'processing',analysisRequestId:'existing-token',analysisLeaseExpiresAt:new Date(Date.now()+60000)});
 await Controller.analyzeConversation(req,res);
 expect(res.status).toHaveBeenCalledWith(400);expect(Service.analyze).not.toHaveBeenCalled();expect(Valuation.beginValuation).not.toHaveBeenCalled();
 expect((await Intelligence.findOne({conversation:conversation._id})).analysisRequestId).toBe('existing-token');
});
test('rejects another tenant before creating any claim or invoking AI',async()=>{
 await Conversation.collection.updateOne({_id:conversation._id},{$set:{business:new mongoose.Types.ObjectId()}});
 await Controller.analyzeConversation(req,res);
 expect(res.status).toHaveBeenCalledWith(401);expect(Service.analyze).not.toHaveBeenCalled();expect(await Intelligence.countDocuments()).toBe(0);
});
test('successful completion preserves staff fields and uses the lead snapshot after reservation',async()=>{
 await Intelligence.create({business:business._id,conversation:conversation._id,status:'completed',nextBestAction:{completed:true,outcome:'Staff recorded outcome'}});
 Valuation.beginValuation.mockImplementationOnce(async()=>{await Lead.updateOne({_id:lead._id},{$set:{notes:'Reserved after initial read'}});return {id:'synthetic'};});
 await Controller.analyzeConversation(req,res);
 expect(res.status).toHaveBeenCalledWith(200);
 expect(Service.analyze).toHaveBeenCalledWith(expect.objectContaining({lead:expect.objectContaining({notes:'Reserved after initial read'})}));
 const saved=await Intelligence.findOne({conversation:conversation._id});
 expect(saved.status).toBe('completed');expect(saved.nextBestAction).toMatchObject({actionType:'call_soon',completed:true,outcome:'Staff recorded outcome'});
 expect((await Lead.findById(lead._id)).toObject()).toMatchObject({summary:'Repair request',urgency:'emergency',leadQualityScore:50});
});
test('a superseded persisted claim cannot update lead, valuation or sockets',async()=>{
 Service.analyze.mockImplementationOnce(async()=>{
  await Intelligence.updateOne({conversation:conversation._id},{$set:{analysisRequestId:'newer-token'}});return analysis;
 });
 await Controller.analyzeConversation(req,res);
 expect((await Intelligence.findOne({conversation:conversation._id})).analysisRequestId).toBe('newer-token');
 expect((await Lead.findById(lead._id)).summary).not.toBe('Repair request');
 expect(Valuation.finishValuation).not.toHaveBeenCalled();expect(Socket.emitToBusiness).not.toHaveBeenCalled();
});
test('provider failure releases only the matching persisted processing claim',async()=>{
 Service.analyze.mockRejectedValueOnce(new Error('Synthetic provider failed'));
 await Controller.analyzeConversation(req,res);
 expect(res.status).toHaveBeenCalledWith(500);
 expect((await Intelligence.findOne({conversation:conversation._id})).toObject()).toMatchObject({status:'failed',analysisLeaseExpiresAt:null});
});
test('provider failure cannot release a newer processing claim',async()=>{
 Service.analyze.mockImplementationOnce(async()=>{
  await Intelligence.updateOne({conversation:conversation._id},{$set:{analysisRequestId:'newer-token'}});throw new Error('Synthetic provider failed');
 });
 await Controller.analyzeConversation(req,res);
 expect((await Intelligence.findOne({conversation:conversation._id})).toObject()).toMatchObject({status:'processing',analysisRequestId:'newer-token'});
});
test('ancillary lead update failure cannot relabel a durable completed analysis',async()=>{
 jest.spyOn(Lead,'findOneAndUpdate').mockRejectedValueOnce(new Error('Synthetic lead write unavailable'));
 await Controller.analyzeConversation(req,res);
 expect(res.status).toHaveBeenCalledWith(200);expect((await Intelligence.findOne({conversation:conversation._id})).status).toBe('completed');
});

test('a conversation without a lead can be analyzed without fabricating or changing a lead',async()=>{
 await Conversation.updateOne({_id:conversation._id},{$set:{lead:null}});
 await Controller.analyzeConversation(req,res);
 expect(res.status).toHaveBeenCalledWith(200);expect(Service.analyze).toHaveBeenCalledWith(expect.objectContaining({lead:null}));
 expect((await Intelligence.findOne({conversation:conversation._id})).toObject()).toMatchObject({status:'completed',lead:null});
 expect((await Lead.findById(lead._id)).summary).not.toBe('Repair request');
});
