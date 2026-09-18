#!/usr/bin/env node
// Read-only, bounded diagnostic. Never sends, requeues, or repairs messages.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config({ quiet: true });
const args = process.argv.slice(2);
const value = args[args.indexOf('--conversation') + 1];
try {
  if (!args.includes('--conversation') || !/^[a-f0-9]{24}$/i.test(value || '')) throw new Error('Usage: node scripts/diagnose-sms-conversation.mjs --conversation OBJECT_ID');
  if (!process.env.MONGO_URL) throw new Error('MONGO_URL is missing.');
  await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 10000, autoIndex: false });
  const db = mongoose.connection.db;
  const conversation = await db.collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(value) }, {
    projection: { business: 1, lead: 1, status: 1, aiEnabled: 1, humanTakeover: 1, 'orchestration.phase': 1, 'orchestration.handoffReason': 1 }
  });
  if (!conversation) throw new Error('Conversation not found.');
  const scope = { business: conversation.business, conversation: conversation._id };
  const [lead, jobs, outbound] = await Promise.all([
    db.collection('leads').findOne({ _id: conversation.lead, business: conversation.business }, { projection: { _id: 1 } }),
    db.collection('smsprocessingjobs').find(scope, { projection: { lead: 1, status: 1, result: 1, attemptCount: 1, availableAt: 1, completedAt: 1 } }).sort({ createdAt: -1 }).limit(10).toArray(),
    db.collection('messages').find({ ...scope, direction: 'outbound' }, { projection: { status: 1, deliveryStatus: 1, providerMessageId: 1, deliveryErrorCode: 1, 'metadata.suppressionReason': 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(10).toArray()
  ]);
  console.log(JSON.stringify({ conversation, linkedLeadExists: Boolean(lead), jobs: jobs.map(job => ({ ...job, leadMatches: String(job.lead) === String(conversation.lead) })), outbound }, null, 2));
} catch (error) {
  console.error(String(error.message).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[database URL hidden]'));
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
