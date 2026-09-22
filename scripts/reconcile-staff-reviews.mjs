#!/usr/bin/env node
import 'dotenv/config';
import mongoose from 'mongoose';
import { reconcileStaffReviewPage } from '../src/services/staffReviewReconciliation.service.js';
const apply = process.argv.includes('--apply');
const businessId = process.argv.find(value => value.startsWith('--business='))?.slice('--business='.length);
if (!businessId || !mongoose.isValidObjectId(businessId)) throw new Error('Supply --business=<business-id>. Default is a read-only audit; --apply repairs missing reviews.');
const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if (!uri) throw new Error('MongoDB connection is not configured.');
await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
try {
  let cursor = null;
  const counts = {};
  do {
    const page = await reconcileStaffReviewPage({ businessId, after: cursor, apply });
    for (const result of page.results) counts[result.status] = (counts[result.status] || 0) + 1;
    cursor = page.nextCursor;
  } while (cursor);
  console.log(JSON.stringify({ mode: apply ? 'repair' : 'audit', counts }, null, 2));
  if (counts.failed) process.exitCode = 1;
} finally { await mongoose.disconnect(); }
