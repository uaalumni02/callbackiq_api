import mongoose from 'mongoose';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
beforeAll(connectTestDB);afterEach(clearTestDB);afterAll(closeTestDB);
const scope=()=>new mongoose.Types.ObjectId();
test.each(['conversation','lead'])('stale %s cannot undo a newer staff decision',async kind=>{
 const business=scope();const Model=kind==='lead'?Lead:Conversation;
 const doc=await Model.create(kind==='lead'?{business,phone:'+14045550101',customerName:'Synthetic',serviceNeeded:'Sink repair'}:{business,customerPhone:'+14045550101'});
 const stale=await Model.findById(doc._id);
 await Model.updateOne({_id:doc._id},{$set:kind==='lead'?{status:'lost'}:{humanTakeover:true,aiEnabled:false}});
 if(kind==='lead')stale.status='contacted';else{stale.humanTakeover=false;stale.aiEnabled=true;}
 await expect(stale.save()).rejects.toMatchObject({name:'DocumentNotFoundError'});
 const current=await Model.findById(doc._id);expect(JSON.stringify(current)).not.toContain('stateVersion');
 expect(kind==='lead'?current.status:current.humanTakeover).toBe(kind==='lead'?'lost':true);
});
test('sequential saves retain explicit predicates, sessions, and immutable tenant identity',async()=>{
 const doc=await Conversation.create({business:scope(),customerPhone:'+14045550102'});
 doc.$where={status:'open'};doc.lastMessage='first';await doc.save();doc.lastMessage='second';await doc.save();
 expect(doc.$where).toEqual({status:'open'});doc.business=scope();await expect(doc.save()).rejects.toMatchObject({code:'STATE_VERSION_CONFLICT'});
});

test('batched SMS snapshots fence older documents as well as ordinary updates',async()=>{
 const { updateSmsConversationSnapshot }=await import('../../src/services/messaging/smsConversationUpdateBatch.service.js');
 const business=scope(),a=await Conversation.create({business,customerPhone:'+14045550103'}),b=await Conversation.create({business,customerPhone:'+14045550104'});
 const stale=await Conversation.findById(a._id);
 await Promise.all([a,b].map(doc=>updateSmsConversationSnapshot({businessId:business,conversationId:doc._id,update:{lastMessage:'fresh snapshot'}})));
 stale.lastMessage='stale snapshot';await expect(stale.save()).rejects.toMatchObject({name:'DocumentNotFoundError'});
});

test('pipeline updates participate in stale-write fencing and cannot reset the private version',async()=>{
 const doc=await Conversation.create({business:scope(),customerPhone:'+14045550105'}),stale=await Conversation.findById(doc._id);
 await Conversation.updateOne({_id:doc._id},[{$set:{lastMessage:'pipeline update'}}],{updatePipeline:true});
 stale.lastMessage='lost update';await expect(stale.save()).rejects.toMatchObject({name:'DocumentNotFoundError'});
 await expect(Conversation.updateOne({_id:doc._id},{$set:{stateVersion:0}})).rejects.toMatchObject({code:'STATE_VERSION_CONFLICT'});
 expect((await Conversation.findById(doc._id)).lastMessage).toBe('pipeline update');
});

test('a fenced valuation reservation can continue its own document without granting stale writers access',async()=>{
 const {beginValuation}=await import('../../src/services/valuation/opportunityValuation.service.js');
 const doc=await Lead.create({business:scope(),phone:'+14045550106',customerName:'Synthetic',serviceNeeded:'Sink repair'}),stale=await Lead.findById(doc._id);
 const ticket=await beginValuation(doc,doc.business);expect(ticket).toBeTruthy();
 doc.serviceNeeded='Leaking sink repair';await doc.save();stale.status='lost';await expect(stale.save()).rejects.toMatchObject({name:'DocumentNotFoundError'});
 const current=await Lead.findById(doc._id);expect(current.serviceNeeded).toBe('Leaking sink repair');expect(current.status).not.toBe('lost');
});
test('a valuation reservation never refreshes past another writer decision',async()=>{
 const {beginValuation}=await import('../../src/services/valuation/opportunityValuation.service.js');
 const doc=await Lead.create({business:scope(),phone:'+14045550107',customerName:'Synthetic',serviceNeeded:'Sink repair'});
 await Lead.updateOne({_id:doc._id},{$set:{status:'lost'}});
 expect(await beginValuation(doc,doc.business)).toBeNull();doc.serviceNeeded='Older details';await expect(doc.save()).rejects.toMatchObject({name:'DocumentNotFoundError'});
 expect((await Lead.findById(doc._id)).status).toBe('lost');
});

test('an update returns the private version needed by a subsequent owned save',async()=>{
 const business=scope(),row=await Conversation.create({business,customerPhone:'+14045550108'});
 const updated=await Conversation.findOneAndUpdate({_id:row._id,business},{$set:{lastMessage:'owned'}},{returnDocument:'after'});
 updated.lastMessage='owned continuation';await updated.save();expect((await Conversation.findById(row._id)).lastMessage).toBe('owned continuation');
});
test('an older fallback projection cannot overwrite a newer customer message or another tenant',async()=>{
 const {persistVoiceFallbackPreview}=await import('../../src/services/stateTransitions/messaging.js');
 const business=scope(),at=new Date(),row=await Conversation.create({business,customerPhone:'+14045550109',lastMessage:'newer',lastMessageAt:new Date(at.getTime()+1000)});
 expect(await persistVoiceFallbackPreview({Conversation,conversation:row,business:{_id:business},body:'older',at})).toBeNull();
 expect(await persistVoiceFallbackPreview({Conversation,conversation:row,business:{_id:scope()},body:'foreign',at:new Date(at.getTime()+2000)})).toBeNull();
 expect((await Conversation.findById(row._id)).lastMessage).toBe('newer');
});

test('valuation completion preserves unrelated facts changed during its own analysis',async()=>{
 const {beginValuation,finishValuation}=await import('../../src/services/valuation/opportunityValuation.service.js');
 const doc=await Lead.create({business:scope(),phone:'+14045550110',customerName:'Synthetic',serviceNeeded:'Sink repair'});
 const ticket=await beginValuation(doc,doc.business);expect(ticket).toBeTruthy();
 await Lead.updateOne({_id:doc._id},{$set:{summary:'Newer customer facts'}});
 const valued=await finishValuation(ticket,{businessId:doc.business,evidence:'Sink repair'});
 expect(valued).toBeTruthy();expect(valued.summary).toBe('Newer customer facts');expect(valued.valuationVersion).toBe(ticket.valuationVersion+1);
});
