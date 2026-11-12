import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/app.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import CallLog from '../../src/models/callLog.js';
import Message from '../../src/models/message.js';
import Intelligence from '../../src/models/conversationIntelligence.js';
import Token from '../../src/helpers/jwt/token.js';
import {qualifyLeadWithAI} from '../../src/helpers/ai/openaiClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
jest.mock('../../src/helpers/ai/openaiClient.js',()=>({qualifyLeadWithAI:jest.fn()}));
let fixture;
beforeAll(connectTestDB,60000);afterAll(closeTestDB);
beforeEach(async()=>{
 jest.clearAllMocks();
 const {business}=await trackingFixture();
 const owner=await User.create({_id:business.owner,userName:'synthetic-http-owner',email:'owner-http@example.test',password:'synthetic-hash',role:'owner',businessName:'Synthetic owner',businessPhone:business.phone});
 const foreign=await Business.create({owner:new mongoose.Types.ObjectId(),businessName:'FOREIGN-TENANT-SYNTHETIC',businessType:'plumbing',email:'foreign-http@example.test',phone:'+14045550124',forwardingPhone:'+14045550998'});
 const records=async(scope,name)=>{
  const lead=await Lead.create({business:scope._id,customerName:name,phone:'+14045550125',serviceNeeded:'Sink repair',status:'new',urgency:'medium',leadQualityScore:40});
  const conversation=await Conversation.create({business:scope._id,lead:lead._id,customerPhone:lead.phone,lastMessage:'Synthetic request'});
  const call=await CallLog.create({business:scope._id,lead:lead._id,conversation:conversation._id,from:lead.phone,to:scope.phone});
  const message=await Message.create({business:scope._id,lead:lead._id,conversation:conversation._id,direction:'inbound',from:lead.phone,to:scope.phone,body:name});
  await Intelligence.create({business:scope._id,conversation:conversation._id,lead:lead._id,status:'completed'});
  return {lead,conversation,call,message};
 };
 fixture={business,owned:await records(business,'Owned synthetic customer'),foreign:await records(foreign,'FOREIGN-TENANT-SYNTHETIC'),token:Token.sign({userId:owner._id,role:'owner',sessionVersion:0})};
 qualifyLeadWithAI.mockResolvedValue({serviceNeeded:'Sink repair',urgency:'medium',leadQualityScore:60,summary:'Qualified synthetic request',messageCategory:'service_request'});
});
afterEach(clearTestDB);
const leadBody={phone:'+14045550125',serviceNeeded:'Sink repair',customerName:'Owner edit',status:'contacted'};
const routes=[
 ['get','leads','lead',()=>undefined],['delete','leads','lead',()=>undefined],['patch','leads','lead',()=>leadBody],['patch','leads','lead',()=>({status:'contacted'}),'/status'],
 ['get','calls','call',()=>undefined],['patch','calls','call',()=>({notes:'Owner edit'})],['delete','calls','call',()=>undefined],
 ['get','messages','message',()=>undefined],['delete','messages','message',()=>undefined],
 ['get','conversation-intelligence','conversation',()=>undefined],
 ['patch','conversation-intelligence','conversation',()=>({rating:'helpful'}),'/feedback'],
 ['patch','conversation-intelligence','conversation',()=>({completed:true}),'/action'],
 ['delete','conversation-intelligence','conversation',()=>undefined],
 ['post','conversation-intelligence','conversation',()=>({}),'/analyze'],
];
for(const [method,resource,key,body,suffix=''] of routes){
 test.each(['foreign','missing'])(`${method.toUpperCase()} ${resource}${suffix} preserves %s isolation and error behavior`,async scope=>{
  const id=scope==='foreign'?fixture.foreign[key]._id:new mongoose.Types.ObjectId();
  let command=request(app)[method](`/api/${resource}/${id}${suffix}`).set('Authorization',`Bearer ${fixture.token}`);
  if(body()!==undefined)command=command.send(body());
  const response=await command;
  expect(response.status).toBe(scope==='foreign'?401:400);
  expect(JSON.stringify(response.body)).not.toContain('FOREIGN-TENANT-SYNTHETIC');
  expect((await Lead.findById(fixture.foreign.lead._id)).status).toBe('new');
  expect((await CallLog.findById(fixture.foreign.call._id)).notes).not.toBe('Owner edit');
  expect(await Message.findById(fixture.foreign.message._id)).not.toBeNull();
  const analysis=await Intelligence.findOne({conversation:fixture.foreign.conversation._id});
  expect(analysis.status).toBe('completed');expect(analysis.feedback?.rating).not.toBe('helpful');expect(analysis.nextBestAction.completed).toBe(false);
 });
}
test('owned lead, call and qualification writes still persist through the scoped interfaces',async()=>{
 const auth=`Bearer ${fixture.token}`;
 const lead=await request(app).patch(`/api/leads/${fixture.owned.lead._id}`).set('Authorization',auth).send(leadBody);
 expect(lead.status).toBe(200);expect((await Lead.findById(fixture.owned.lead._id)).customerName).toBe('Owner edit');
 const status=await request(app).patch(`/api/leads/${fixture.owned.lead._id}/status`).set('Authorization',auth).send({status:'lost'});
 expect(status.status).toBe(200);expect((await Lead.findById(fixture.owned.lead._id)).status).toBe('lost');
 const call=await request(app).patch(`/api/calls/${fixture.owned.call._id}`).set('Authorization',auth).send({notes:'Owner edit'});
 expect(call.status).toBe(200);expect((await CallLog.findById(fixture.owned.call._id)).notes).toBe('Owner edit');
 const qualification=await request(app).post('/api/ai/qualify-lead').set('Authorization',auth).send({leadId:String(fixture.owned.lead._id),messageBody:'Synthetic sink repair request'});
 expect(qualification.status).toBe(200);expect((await Lead.findById(fixture.owned.lead._id)).summary).toBe('Qualified synthetic request');
 expect(qualifyLeadWithAI).toHaveBeenCalledTimes(1);
});

test('owned deletion retains call audit history and cannot delete another tenant records',async()=>{
 const auth=`Bearer ${fixture.token}`;
 const call=await request(app).delete(`/api/calls/${fixture.owned.call._id}`).set('Authorization',auth);
 expect(call.status).toBe(200);expect((await CallLog.findById(fixture.owned.call._id)).deletedAt).toBeInstanceOf(Date);
 expect((await request(app).get(`/api/calls/${fixture.owned.call._id}`).set('Authorization',auth)).status).toBe(400);
 expect((await request(app).delete(`/api/messages/${fixture.owned.message._id}`).set('Authorization',auth)).status).toBe(200);
 expect(await Message.findById(fixture.owned.message._id)).toBeNull();
 expect((await request(app).delete(`/api/leads/${fixture.owned.lead._id}`).set('Authorization',auth)).status).toBe(200);
 expect(await Lead.findById(fixture.owned.lead._id)).toBeNull();
 expect(await Lead.findById(fixture.foreign.lead._id)).not.toBeNull();expect(await Message.findById(fixture.foreign.message._id)).not.toBeNull();
});

test('owned reads, feedback and action receipts remain usable through the same tenant boundary',async()=>{
 const auth=`Bearer ${fixture.token}`;
 for(const [resource,key] of [['leads','lead'],['calls','call'],['messages','message'],['conversation-intelligence','conversation']]){
  const response=await request(app).get(`/api/${resource}/${fixture.owned[key]._id}`).set('Authorization',auth);
  expect(response.status).toBe(200);expect(JSON.stringify(response.body)).not.toContain('FOREIGN-TENANT-SYNTHETIC');
 }
 const history=await request(app).get(`/api/messages/conversation/${fixture.owned.conversation._id}`).set('Authorization',auth);
 expect(history.status).toBe(200);expect(history.body.data.map(row=>row.body)).toEqual(['Owned synthetic customer']);
 expect((await request(app).patch(`/api/conversation-intelligence/${fixture.owned.conversation._id}/feedback`).set('Authorization',auth).send({rating:'helpful',notes:'Owner feedback'})).status).toBe(200);
 expect((await request(app).patch(`/api/conversation-intelligence/${fixture.owned.conversation._id}/action`).set('Authorization',auth).send({completed:true,outcome:'Staff followed up'})).status).toBe(200);
 const saved=await Intelligence.findOne({conversation:fixture.owned.conversation._id});expect(saved.feedback.rating).toBe('helpful');expect(saved.nextBestAction.completed).toBe(true);
 const foreign=await Intelligence.findOne({conversation:fixture.foreign.conversation._id});expect(foreign.feedback?.rating).not.toBe('helpful');expect(foreign.nextBestAction.completed).toBe(false);
});
