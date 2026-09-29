import 'dotenv/config';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';
if (process.argv.includes('--help')) {
  console.log('Requires MONGO_URL, BACKUP_DIR and BACKUP_WRITES_PAUSED=true. Stop all application writers for the whole dump. Creates a private archive, SHA256, and collection/count/index manifest. No restore is performed.');
} else {
  if (!getMongoUrl() || !process.env.BACKUP_DIR || process.env.BACKUP_WRITES_PAUSED !== 'true') throw new Error('Set MONGO_URL, BACKUP_DIR and BACKUP_WRITES_PAUSED=true after pausing all writers.');
  process.umask(0o077);
  const destination = path.join(path.resolve(process.env.BACKUP_DIR), `callbackiq-${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID().slice(0,8)}`);
  await fs.mkdir(destination,{recursive:true,mode:0o700});
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'callbackiq-dump-'));
  try {
    await mongoose.connect(getMongoUrl(),{autoIndex:false,serverSelectionTimeoutMS:10000});
    const db=mongoose.connection.db;
    if (['admin','local','config','test'].includes(db.databaseName)) throw new Error('Configure an explicit application database in MONGO_URL.');
    const collections=[];
    for (const row of await db.listCollections({type:'collection'}).toArray()) {
      if (row.name.startsWith('system.')) continue;
      const collection=db.collection(row.name);
      collections.push({name:row.name,count:await collection.countDocuments({}),indexes:await collection.indexes()});
    }
    if (!collections.length) throw new Error('Refusing to certify an empty source database.');
    const config=path.join(temporary,'config.yml');
    await fs.writeFile(config,`uri: ${JSON.stringify(getMongoUrl())}\n`,{mode:0o600});
    const archive=path.join(destination,'database.archive.gz');
    // Do not print provider output: URI-bearing errors must not reach logs.
    await new Promise((resolve,reject)=>{
      const child=spawn('mongodump',[`--config=${config}`,`--db=${db.databaseName}`,`--archive=${archive}`,'--gzip'],{stdio:'ignore'});
      child.once('error',()=>reject(new Error('Could not start mongodump; install MongoDB Database Tools.')));
      child.once('exit',code=>code===0?resolve():reject(new Error(`mongodump failed (exit ${code}); backup is incomplete.`)));
    });
    for (const row of collections) if (await db.collection(row.name).countDocuments({}) !== row.count) throw new Error('Source counts changed during backup. Keep all writers paused and repeat.');
    const hash=crypto.createHash('sha256');for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const manifest={version:1,createdAt:new Date().toISOString(),database:db.databaseName,writesPaused:true,archive:'database.archive.gz',sha256:hash.digest('hex'),collections};
    await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(`Backup created: ${destination}\nRestore into an isolated database and run restore:verify before treating it as a tested backup.`);
  } finally {await mongoose.disconnect();await fs.rm(temporary,{recursive:true,force:true});}
}
