import mongoose from 'mongoose';
import Db from '../../src/db/db.js';
import Conversation from '../../src/models/conversation.js';
import CallLog from '../../src/models/callLog.js';
import Lead from '../../src/models/lead.js';
import User from '../../src/models/user.js';
import Message from '../../src/models/message.js';
import Alert from '../../src/models/alert.js';
import SupportTicket from '../../src/models/supportTicket.js';
import Subscription from '../../src/models/subscription.js';
import {getMessagesPage} from '../../src/services/cursorPagination.service.js';
import {tenantContext,tenantRepository} from '../../src/db/repositories/tenantRepository.js';
import {adminReadById,adminUpdateById,adminDeleteById} from '../../src/db/repositories/privileged/adminRepository.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
beforeAll(connectTestDB,60000);afterEach(clearTestDB);afterAll(closeTestDB);
async function fixture(){
 const {business}=await trackingFixture();
 const conversation=await Conversation.create({business:business._id,lead:null,customerPhone:'+14045550125',lastMessage:'Synthetic customer request'});
 const call=await CallLog.create({business:business._id,from:'+14045550125',to:'+14045550123'});
 return {business,conversation,call};
}
test.each(['conversation','call'])('%s owner updates reject absent tenant context at the interface',async resource=>{
 const {conversation,call}=await fixture();
 const operation=resource==='conversation'?Db.updateConversationForBusiness(Conversation,conversation._id,undefined,{$set:{status:'closed'}})
  :Db.updateCallLogForBusiness(CallLog,call._id,undefined,{$set:{notes:'Edited'}});
 await expect(operation).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 expect((await Conversation.findById(conversation._id)).status).toBe('open');
 expect((await CallLog.findById(call._id)).notes).not.toBe('Edited');
});
test('a tenant update cannot silently accept a request to move document ownership',async()=>{
 const {business,conversation}=await fixture();
 await expect(Db.updateConversationForBusiness(Conversation,conversation._id,business._id,{$set:{business:new mongoose.Types.ObjectId()}})).rejects.toMatchObject({code:'INVALID_TENANT_UPDATE'});
 expect(String((await Conversation.findById(conversation._id)).business)).toBe(String(business._id));
});
test('the repository rejects a foreign lead before persisting or populating the relationship',async()=>{
 const {business,conversation}=await fixture(),foreignBusiness=new mongoose.Types.ObjectId();
 const foreign=await Lead.create({business:foreignBusiness,customerName:'Synthetic foreign customer',phone:'+14045550126',serviceNeeded:'Plumbing repair'});
 await expect(Db.updateConversationForBusiness(Conversation,conversation._id,business._id,{$set:{lead:foreign._id}})).rejects.toMatchObject({code:'INVALID_TENANT_REFERENCE'});
 expect((await Conversation.findById(conversation._id)).lead).toBeNull();
});
test('a valid tenant context cannot update another business by ID',async()=>{
 const {conversation}=await fixture(),foreignBusiness=new mongoose.Types.ObjectId();
 expect(await Db.updateConversationForBusiness(Conversation,conversation._id,foreignBusiness,{$set:{status:'closed'}})).toBeNull();
 expect((await Conversation.findById(conversation._id)).status).toBe('open');
});
test('the owner facade cannot export ID-only mutation capabilities',()=>{
 for(const name of ['updateLead','deleteLead','updateConversation','deleteConversation','deleteMessage','updateCallLog',
  'deleteCallLog','qualifyLead','updateAlert','markAlertAsRead','deleteAlert','updateConversationIntelligence','deleteConversationIntelligence']){
  expect(Db[name]).toBeUndefined();
 }
});
test('the shared interface reads, updates, populates and removes only the bound tenant',async()=>{
 const {business,conversation}=await fixture();
 const lead=await Lead.create({business:business._id,customerName:'Synthetic owned customer',phone:'+14045550127',serviceNeeded:'Leak repair'});
 const repo=tenantRepository(Conversation,tenantContext(business._id));
 expect((await repo.read(conversation._id))._id).toEqual(conversation._id);
 const updated=await repo.update(conversation._id,{lead:lead._id,customerName:'Updated'},
  {populate:[{path:'business',select:'businessName'},{path:'lead',select:'customerName'}]});
 expect(updated.lead.customerName).toBe('Synthetic owned customer');expect(updated.business._id).toEqual(business._id);
 const read=repo.read(conversation._id);expect(updated.save).toBeUndefined();expect(read.where).toBeUndefined();await read;
 expect(await tenantRepository(Conversation,tenantContext(new mongoose.Types.ObjectId())).remove(conversation._id)).toBeNull();
 expect((await repo.remove(conversation._id))._id).toEqual(conversation._id);expect(await Conversation.findById(conversation._id)).toBeNull();
});
test.each([{$rename:{business:'oldBusiness'}},[{$set:{status:'closed'}}],{$unset:{business:1}},{$set:{'memory.__proto__.value':true}}])('unsafe update shape %p is rejected before persistence',async update=>{
 const {business,conversation}=await fixture();
 await expect(tenantRepository(Conversation,tenantContext(business._id)).update(conversation._id,update)).rejects.toMatchObject({code:'INVALID_TENANT_UPDATE'});
 expect((await Conversation.findById(conversation._id)).status).toBe('open');
});
test('privileged ID-only mutations require a fresh database admin role and a named operation',async()=>{
 const {business,conversation}=await fixture();
 const actor=await User.create({_id:business.owner,userName:'tenantadmin',email:'tenant-admin@example.test',password:'synthetic',businessName:'Synthetic admin',role:'owner'});
 const input={model:Conversation,id:conversation._id,actorId:actor._id,reason:'MAINTENANCE_CONTRACT',update:{$set:{status:'closed'}}};
 await expect(adminUpdateById(input)).rejects.toMatchObject({code:'PRIVILEGED_ACCESS_DENIED'});
 await User.updateOne({_id:actor._id},{$set:{role:'admin'}});
 expect((await adminReadById(input))._id).toEqual(conversation._id);
 expect((await adminUpdateById(input)).status).toBe('closed');
 await User.updateOne({_id:actor._id},{$set:{role:'owner'}});
 await expect(adminDeleteById(input)).rejects.toMatchObject({code:'PRIVILEGED_ACCESS_DENIED'});
 expect(await Conversation.findById(conversation._id)).not.toBeNull();
 await User.updateOne({_id:actor._id},{$set:{role:'admin'}});
 await expect(adminDeleteById({...input,reason:''})).rejects.toMatchObject({code:'PRIVILEGED_ACCESS_DENIED'});
 expect((await adminDeleteById(input))._id).toEqual(conversation._id);
});

test.each([['saveLead',Lead],['saveConversation',Conversation],['saveCallLog',CallLog],['saveMessage',Message],['saveAlert',Alert]])('%s requires tenant context before validating or creating data',async(name,model)=>{
 const {business}=await fixture();
 await expect(Db[name](model,{business:business._id})).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
});
test.each([['getLeadsByBusiness',Lead],['getConversationsByBusiness',Conversation],['getCallLogsByBusiness',CallLog],['getAlertsByBusiness',Alert],['getUnreadAlertsByBusiness',Alert]])('%s rejects missing context rather than forming a permissive query',async(name,model)=>{
 await expect(Db[name](model,undefined)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
});
test('conversation histories require a business context and exclude inconsistent foreign message references',async()=>{
 const {business,conversation}=await fixture(),foreign=new mongoose.Types.ObjectId();
 const owned=await Message.create({business:business._id,conversation:conversation._id,direction:'inbound',from:'+14045550125',to:'+14045550123',body:'Owned'});
 await Message.collection.insertOne({business:foreign,conversation:conversation._id,direction:'inbound',body:'Foreign synthetic',createdAt:new Date()});
 await expect(Db.getMessagesByConversation(Message,conversation._id)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 await expect(Db.getMessagesForAI(Message,conversation._id)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 for(const method of ['getMessagesByConversation','getMessagesForAI']){
  const rows=await Db[method](Message,conversation._id,business._id);
  expect(rows.map(row=>String(row._id))).toEqual([String(owned._id)]);
 }
});
test('creation and bulk mutations keep the bound tenant even when criteria request another business',async()=>{
 const {business,conversation}=await fixture(),foreign=new mongoose.Types.ObjectId();
 const repo=tenantRepository(Conversation,tenantContext(business._id));
 await expect(repo.create({business:foreign,customerPhone:'+14045550129'})).rejects.toMatchObject({code:'INVALID_TENANT_UPDATE'});
 const created=await repo.create({customerPhone:'+14045550129',lastMessage:'Synthetic'});expect(created.business).toEqual(business._id);expect(created.save).toBeUndefined();
 expect(await repo.list({business:foreign})).toEqual([]);expect(await repo.count({business:foreign})).toBe(0);
 expect((await repo.updateMany({business:foreign},{$set:{status:'closed'}})).matchedCount).toBe(0);
 expect((await repo.read(conversation._id)).status).toBe('open');
 expect((await repo.updateMany({_id:conversation._id},{$set:{status:'closed'}})).modifiedCount).toBe(1);
 expect((await repo.read(conversation._id)).status).toBe('closed');
});

test('paginated conversation history cannot return a foreign message through an owned conversation',async()=>{
 const {business,conversation}=await fixture();
 const owned=await Message.create({business:business._id,conversation:conversation._id,direction:'inbound',from:'+14045550125',to:'+14045550123',body:'Owned page'});
 await Message.collection.insertOne({business:new mongoose.Types.ObjectId(),conversation:conversation._id,direction:'inbound',body:'Foreign page',createdAt:new Date()});
 await expect(getMessagesPage(conversation._id,{})).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 const page=await getMessagesPage(conversation._id,{}, {businessId:business._id,conversation});
 expect(page.items.map(row=>String(row._id))).toEqual([String(owned._id)]);
});

test('a business transfer between authorization and archive cannot mutate the new owner record',async()=>{
 const {business,conversation}=await fixture(),newOwner=new mongoose.Types.ObjectId();
 const repo=tenantRepository(Conversation,tenantContext(business._id));
 expect((await repo.readForAccess(conversation._id)).outcome).toBe('owned');
 await Conversation.collection.updateOne({_id:conversation._id},{$set:{business:newOwner}});
 expect(await Db.updateConversationForBusiness(Conversation,conversation._id,business._id,{$set:{status:'archived'}})).toBeNull();
 expect((await Conversation.findById(conversation._id)).status).toBe('open');
 expect((await repo.readForAccess(conversation._id)).outcome).toBe('forbidden');
});
test('a database failure emits one named tenant event and propagates the original error without fabricating data',async()=>{
 const {business,conversation}=await fixture(),error=Object.assign(new Error('Synthetic provider-free database outage'),{code:'SYNTHETIC_DB_UNAVAILABLE'});
 const output=jest.spyOn(console,'error').mockImplementation(()=>{});
 const query=jest.spyOn(Conversation,'findOne').mockImplementation(()=>{throw error;});
 try{
  await expect(tenantRepository(Conversation,tenantContext(business._id)).read(conversation._id)).rejects.toBe(error);
  expect(output).toHaveBeenCalledTimes(1);
  expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({event:'repository.tenant_operation_failed',businessId:String(business._id),operation:'read',code:'SYNTHETIC_DB_UNAVAILABLE'});
 }finally{query.mockRestore();output.mockRestore();}
});

test('support and subscription owner reads require context, and support updates cannot transfer ownership',async()=>{
 const {business}=await fixture();
 const ticket=await SupportTicket.create({business:business._id,user:business.owner,subject:'Synthetic support',message:'Synthetic request'});
 await expect(Db.getSupportTicketForBusiness(SupportTicket,ticket._id)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 await expect(Db.getSupportTicketsByBusiness(SupportTicket)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 await expect(Db.getSubscriptionByBusiness(Subscription)).rejects.toMatchObject({code:'TENANT_CONTEXT_REQUIRED'});
 await expect(Db.updateSupportTicketForBusiness(SupportTicket,ticket._id,business._id,{business:new mongoose.Types.ObjectId()})).rejects.toMatchObject({code:'INVALID_TENANT_UPDATE'});
 expect((await SupportTicket.findById(ticket._id)).business).toEqual(business._id);
});
test('privileged audit records retain validated numeric ObjectIds as operational identities',async()=>{
 const {business}=await fixture();
 const actorId=new mongoose.Types.ObjectId('000000000000000000000001'),resourceId=new mongoose.Types.ObjectId('000000000000000000000002');
 await User.create({_id:actorId,userName:'numeric-audit-admin',email:'numeric-admin@example.test',password:'synthetic',businessName:'Synthetic admin',role:'admin'});
 await Conversation.create({_id:resourceId,business:business._id,customerPhone:'+14045550129'});
 const output=jest.spyOn(console,'log').mockImplementation(()=>{});
 try{
  expect((await adminReadById({model:Conversation,id:resourceId,actorId,reason:'AUDIT_IDENTITY_CONTRACT'}))._id).toEqual(resourceId);
  const event=output.mock.calls.map(([line])=>JSON.parse(line)).find(record=>record.event==='repository.privileged_access');
  expect(event.actorId).toBe(String(actorId));expect(event.resourceId).toBe(String(resourceId));
 }finally{output.mockRestore();}
});
