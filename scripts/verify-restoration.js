import 'dotenv/config';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {inspectRequiredIndex} from '../src/services/requiredIndexes.service.js';
const uri=process.env.RESTORE_MONGODB_URI;
const manifestPath=process.env.RESTORE_MANIFEST;
if (!uri || !manifestPath) throw new Error('RESTORE_MONGODB_URI and RESTORE_MANIFEST are required. Use an isolated restore target.');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
if(manifest.version!==1 || !manifest.collections?.length || !manifest.writesPaused || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid backup manifest.');
const hash=crypto.createHash('sha256');
for await(const chunk of createReadStream(path.join(path.dirname(manifestPath),'database.archive.gz'))) hash.update(chunk);
if(hash.digest('hex')!==manifest.sha256) throw new Error('Backup archive SHA256 mismatch.');
try {
 await mongoose.connect(uri,{autoIndex:false,serverSelectionTimeoutMS:10000});
 const db=mongoose.connection.db, failures=[];
 const existing=new Set((await db.listCollections().toArray()).map(row=>row.name));
 for(const row of manifest.collections){
  if(!existing.has(row.name)){failures.push(`${row.name}: missing collection`);continue;}
  const collection=db.collection(row.name),count=await collection.countDocuments({});
  if(count!==row.count) failures.push(`${row.name}: expected ${row.count}, restored ${count}`);
  const indexes=await collection.indexes();
  for(const index of row.indexes) if(inspectRequiredIndex(indexes,{key:index.key,options:index})!=='ok') failures.push(`${row.name}: missing/conflicting index ${index.name}`);
 }
 // Check tenant ownership and critical links, without printing customer data.
 const relationships=[['conversations','lead','leads'],['messages','conversation','conversations'],['appointments','lead','leads'],['appointmentnotificationjobs','appointment','appointments'],['staffnotificationjobs','alert','alerts']];
 for(const [collection,field,target] of relationships){
  if(!existing.has(collection)) continue;
  const broken=await db.collection(collection).aggregate([
   {$match:{[field]:{$ne:null}}},
   {$lookup:{from:target,let:{id:`$${field}`,business:'$business'},pipeline:[{$match:{$expr:{$and:[{$eq:['$_id','$$id']},{$eq:['$business','$$business']}]}}}],as:'parent'}},
   {$match:{'parent.0':{$exists:false}}},{$count:'count'}
  ],{maxTimeMS:60000}).toArray();
  if(broken[0]?.count) failures.push(`${collection}.${field}: ${broken[0].count} missing or cross-business links`);
 }
 console.log(JSON.stringify({verifiedAt:new Date().toISOString(),database:db.databaseName,collectionsChecked:manifest.collections.length,failures,passed:failures.length===0},null,2));
 if(failures.length)process.exitCode=1;
} finally {await mongoose.disconnect();}
