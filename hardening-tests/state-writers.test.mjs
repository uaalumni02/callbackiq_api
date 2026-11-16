import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanStateWriters, verifyStateWriters, reviewStateWriterInventory } from '../scripts/state-writers.mjs';
function fixture(t, source) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'state-writer-inventory-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,code)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),code);};
  const owner='src/services/booking/requestBookingPersistence.service.js';
  write(owner,source);
  return {root,write,owner};
}
const source="export function owned(Conversation,id) { return Conversation.updateOne({_id:id,business:'tenant'},{$set:{'bookingState.status':'booked'}}); }";
const inventory=root=>JSON.parse(JSON.stringify({writers:scanStateWriters(root)}));
test('an unchanged registered writer passes with its authority, claim and repair metadata',t=>{
 const f=fixture(t,source),manifest=inventory(f.root);
 assert.equal(verifyStateWriters(scanStateWriters(f.root),manifest).writers,1);
 assert.equal(manifest.writers[0].authoritativeRecord,'Conversation');
 assert.match(manifest.writers[0].predicateSource,/business/);
});
test('a planted unregistered writer fails the actual inventory checker',t=>{
 const f=fixture(t,source),manifest=inventory(f.root);
 f.write('src/bypass.js',"export function bypass(Appointment,id) { return Appointment.updateOne({_id:id},{$set:{status:'confirmed'}}); }");
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/Unregistered state writer \(transition bypass\)/);
 assert.throws(()=>reviewStateWriterInventory(scanStateWriters(f.root),manifest),/inventory regeneration cannot approve/);
});
test('a bypass inserted into a registered owner cannot hide behind its existing registration',t=>{
 const f=fixture(t,source),manifest=inventory(f.root);
 f.write(f.owner,source.replace('return Conversation.updateOne',"const conversation={}; conversation.bookingState={status:'booked'}; return Conversation.updateOne"));
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/Unregistered state writer|owning guard changed/);
});
test('changing the owning guard or filter requires an explicit inventory review',t=>{
 const f=fixture(t,source),manifest=inventory(f.root);
 f.write(f.owner,source.replace("business:'tenant'",'business:id'));
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/owning guard changed/);
});
test('aliases, chained queries, full saves and computed mutation dispatch are inventoried',t=>{
 const f=fixture(t,"import Owned from './models/conversation.js'; export async function owned(id,operation) { const row=await Owned.findOneAndUpdate({_id:id},{$set:{status:'open'}}).lean(); await row.save(); return Owned[operation]({_id:id},{$set:{status:'closed'}}); }");
 const writers=scanStateWriters(f.root);
 assert.deepEqual(writers.map(x=>x.kind),['findOneAndUpdate','save','dynamic-method']);
 assert.ok(writers.every(x=>x.authoritativeRecord==='Conversation'));
});
test('an extracted save capability and document assignments cannot escape the inventory',t=>{
 const f=fixture(t,"export function owned(conversation) { conversation['bookingState.status']='booked'; const persist=conversation.save; return persist.call(conversation); }");
 const rows=scanStateWriters(f.root);
 assert.deepEqual(rows.map(x=>x.kind),['assignment','write-capability-reference']);
});
test('a changed imported authority is rejected even when the writer body stays identical',t=>{
 const f=fixture(t,"import Owned from './models/conversation.js'; export function owned(id){return Owned.updateOne({_id:id},{$set:{status:'open'}});}"),manifest=inventory(f.root);
 f.write(f.owner,fs.readFileSync(path.join(f.root,f.owner),'utf8').replace('/conversation.js','/appointment.js'));
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/owning guard changed/);
});
test('pure reads and HTTP status payloads are not persistence writers',t=>{
 const f=fixture(t,"export function read(Conversation){ const result={status:400}; return Conversation.findOne({status:'open'}).lean(); }");
 assert.deepEqual(scanStateWriters(f.root),[]);
});
test('deleted writers and missing required audit metadata fail closed',t=>{
 const f=fixture(t,source),manifest=inventory(f.root);
 delete manifest.writers[0].versionOrClaim;
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/Missing versionOrClaim/);
 f.write(f.owner,'export const empty=true;');
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/Retired state writer/);
});
test('generic tenant mutations and destructive state removal are conservatively registered',t=>{
 const f=fixture(t,'export const empty=true;');
 f.write('src/db/repositories/tenantRepository.js',"export function change(model,id){return model.findOneAndUpdate({_id:id},{$set:{status:'open'}});}");
 f.write('src/remove.js',"export const remove=Conversation=>Conversation.deleteMany({status:'closed'});");
 const rows=scanStateWriters(f.root);
 assert.equal(rows.find(x=>x.kind==='findOneAndUpdate').authoritativeRecord,'DynamicTenantRecord');
 assert.ok(rows.some(x=>x.kind==='deleteMany'));
});

test('a legacy raw writer remains a bypass even when its entire current body is registered',t=>{
 const f=fixture(t,'export const empty=true;');
 f.write('src/legacy.js',source);
 const manifest=inventory(f.root);
 assert.throws(()=>verifyStateWriters(scanStateWriters(f.root),manifest),/bypasses centralized transitions/);
 assert.throws(()=>reviewStateWriterInventory(scanStateWriters(f.root),manifest),/inventory regeneration cannot approve/);
});
test('optional document saves and imported transition aliases are tracked',t=>{
 const f=fixture(t,"export const empty=true;");
 f.write('src/caller.js',"import { saveStateDocument as persist } from './services/stateTransitions/documents.js'; export function run(row, conversation){ persist(row); conversation.save?.(); }");
 const rows=scanStateWriters(f.root).filter(row=>row.file==='src/caller.js');
 assert.deepEqual(rows.map(row=>row.kind),['transition-command','save']);
 assert.throws(()=>reviewStateWriterInventory(scanStateWriters(f.root),inventory(f.root)),/bypass transition functions/);
});

test('destructured and member-held repository model capabilities cannot hide writes',t=>{
 const f=fixture(t,'export const empty=true;');
 f.write('src/db/repositories/tenantRepository.js',"export function write(scope){ const {model,business}=scope; model.create({business}); return scope.model.updateMany({business},{$set:{status:'closed'}}); }");
 const rows=scanStateWriters(f.root).filter(row=>row.file.includes('tenantRepository'));
 assert.deepEqual(rows.map(row=>row.kind),['create','updateMany']);
 assert.ok(rows.every(row=>row.authoritativeRecord==='DynamicTenantRecord'));
 assert.throws(()=>reviewStateWriterInventory(rows,{writers:rows}),/bypass transition functions/);
});
