import 'dotenv/config';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import Lead from '../src/models/lead.js';
import CallLog from '../src/models/callLog.js';
import Conversation from '../src/models/conversation.js';
import Job from '../src/models/smsProcessingJob.js';
import Message from '../src/models/message.js';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { historyPipeline } from '../src/services/scale/customerHistory.service.js';
import { queryBudgetMs } from '../src/services/scale/queryBudget.js';
const businessId = process.env.SCALE_PROBE_BUSINESS_ID, leadId = process.env.SCALE_PROBE_LEAD_ID;
if (!mongoose.isValidObjectId(businessId) || !mongoose.isValidObjectId(leadId)) throw new Error('Set SCALE_PROBE_BUSINESS_ID and SCALE_PROBE_LEAD_ID');
const business = new mongoose.Types.ObjectId(businessId);
await mongoose.connect(getMongoUrl(), { autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
const records = [];
const collect = (value, result = []) => {
  if (!value || typeof value !== 'object') return result;
  const fields = ['stage', 'nReturned', 'executionTimeMillis', 'executionTimeMillisEstimate', 'totalKeysExamined', 'totalDocsExamined', 'collectionScans', 'indexesUsed', 'usedDisk'];
  const node = Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
  if (Object.keys(node).length) result.push(node);
  for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child, result);
  return result;
};
try {
  const lead = await Lead.findOne({ _id: leadId, business }).maxTimeMS(queryBudgetMs()).lean();
  if (!lead) throw new Error('Probe lead does not belong to the declared business');
  const term = String(process.env.SCALE_PROBE_SEARCH || 'no-match-scale-probe').slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tests = [
    ['owner-page', () => Lead.find({ business }).sort({ updatedAt: -1, _id: -1 }).limit(51).maxTimeMS(queryBudgetMs()).explain('executionStats')],
    ['lead-search', () => Lead.find({ business, $or: ['customerName', 'phone', 'serviceNeeded'].map(key => ({ [key]: new RegExp(term, 'i') })) }).sort({ createdAt: -1, _id: -1 }).limit(51).maxTimeMS(queryBudgetMs()).explain('executionStats')],
    ['call-search', () => CallLog.find({ business, deletedAt: null, $or: ['from', 'to', 'notes', 'transcription'].map(key => ({ [key]: new RegExp(term, 'i') })) }).sort({ createdAt: -1, _id: -1 }).limit(51).maxTimeMS(queryBudgetMs()).explain('executionStats')],
    ['customer-messages', () => Message.aggregate([...historyPipeline({ businessId: business, lead, section: 'messages', pageSize: 50 }), { $sort: { createdAt: -1, _id: -1 } }, { $limit: 51 }]).option({ maxTimeMS: queryBudgetMs() }).explain('executionStats')],
    ['conversation-latest', () => Conversation.find({ business, lead: lead._id }).sort({ lastMessageAt: -1, updatedAt: -1, _id: -1 }).limit(1).maxTimeMS(queryBudgetMs()).explain('executionStats')],
    ['sms-claim-selection', () => Job.find({ $expr: { $lt: ['$attemptCount', '$maxAttempts'] }, $or: [
      { status: { $in: ['queued', 'retry'] }, availableAt: { $lte: new Date() } }, { status: 'processing', leaseExpiresAt: { $lte: new Date() } },
    ] }).sort({ priority: -1, availableAt: 1, createdAt: 1 }).limit(1).maxTimeMS(queryBudgetMs()).explain('executionStats')],
  ];
  for (const [name, execute] of tests) {
    try { records.push({ name, measured: true, plans: collect(await execute()) }); }
    catch (error) { records.push({ name, measured: false, code: String(error.code || error.codeName || 'QUERY_FAILED') }); process.exitCode = 1; }
  }
  const counts = { leads: await Lead.countDocuments({ business }).maxTimeMS(queryBudgetMs()), messages: await Message.countDocuments({ business }).maxTimeMS(queryBudgetMs()) };
  const output = process.env.SCALE_QUERY_REPORT || 'scale-query-report.json';
  await fs.writeFile(output, JSON.stringify({ observedAt: new Date().toISOString(), release: process.env.RELEASE_SHA || 'unrecorded', counts, queries: records }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, queries: records.length, failed: records.filter(x => !x.measured).length }));
} finally { await mongoose.disconnect(); }
