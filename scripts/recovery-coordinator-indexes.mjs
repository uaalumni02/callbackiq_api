#!/usr/bin/env node
// Explicit index migration for the opt-in recovery pilot. Defaults to inspection.
import mongoose from 'mongoose';
import RecoveryCase from '../src/models/recoveryCase.js';
import RecoveryEvent from '../src/models/recoveryEvent.js';
const apply = process.argv.includes('--apply');
const expected = [
  {model:'RecoveryCase', keys:RecoveryCase.schema.indexes().map(([keys,options])=>({keys,unique:!!options.unique}))},
  {model:'RecoveryEvent', keys:RecoveryEvent.schema.indexes().map(([keys,options])=>({keys,unique:!!options.unique}))},
];
console.log(JSON.stringify({apply,expected},null,2));
if (!apply) process.exit(0);
if (process.env.MEEKCALL_RECOVERY_INDEX_MIGRATION_ACK!=='yes') {
  console.error('Specify MEEKCALL_RECOVERY_INDEX_MIGRATION_ACK=yes and --apply after staging review.');
  process.exit(2);
}
const uri=process.env.MONGO_URL||process.env.MONGODB_URI||process.env.MONGO_URI;
if (!uri) {console.error('No MongoDB URL configured');process.exit(2);}
try {
  await mongoose.connect(uri,{serverSelectionTimeoutMS:10000,maxPoolSize:2});
  await RecoveryCase.createIndexes();
  await RecoveryEvent.createIndexes();
  console.log('Recovery coordinator indexes created/verified');
} finally {await mongoose.disconnect();}
