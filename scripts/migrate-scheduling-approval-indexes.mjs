// Additive, non-unique index only. Never drops indexes or changes documents.
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl, normalizeRuntimeEnvironment } from '../src/config/runtime-environment.js';
normalizeRuntimeEnvironment();
const apply = process.argv.includes('--apply');
const uri = getMongoUrl();
if (!uri) throw new Error('MONGODB_URI is required.');
await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
try {
  const collection = mongoose.connection.collection('appointments');
  const key = { requiresBusinessApproval: 1, 'approvalRecovery.reconciled': 1, status: 1, updatedAt: 1 };
  let indexes = [];
  try { indexes = await collection.indexes(); } catch (error) { if (error.code !== 26) throw error; }
  if (indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key))) console.log('Approval recovery index already exists.');
  else if (!apply) console.log('Would add the non-unique approval recovery index. Run with --apply to create it.');
  else { await collection.createIndex(key); console.log('Approval recovery index created.'); }
} finally { await mongoose.disconnect(); }
