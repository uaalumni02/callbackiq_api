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
