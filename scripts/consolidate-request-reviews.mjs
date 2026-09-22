// Explicit, business-scoped repair for legacy per-message reviews. Dry run by default.
// Requires a replica set for the apply transaction; never falls back to partial writes.
import 'dotenv/config';
import mongoose from 'mongoose';
import Alert from '../src/models/alert.js';
import Conversation from '../src/models/conversation.js';
import { requestReviewKey } from '../src/services/requestReview.service.js';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const business = value('--business');
const conversationId = value('--conversation');
const ids = value('--alerts')?.split(',') || [];
if (!args.includes('--business') || !args.includes('--conversation') || !args.includes('--alerts') ||
    ![business, conversationId, ...ids].every(mongoose.isValidObjectId) || ids.length < 2 || new Set(ids).size !== ids.length) {
  throw new Error('Usage: node scripts/consolidate-request-reviews.mjs --business ID --conversation ID --alerts ID,ID [--apply]');
}
const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
if (!uri) throw new Error('MONGODB_URI, MONGO_URI, or MONGO_URL is required');
await mongoose.connect(uri);
try {
  const run = async session => {
    const conversation = await Conversation.findOne({ _id: conversationId, business }).session(session).lean();
    if (!conversation) throw new Error('Scoped conversation not found');
    const rows = await Alert.find({ _id: { $in: ids }, business, conversation: conversationId,
      type: 'human_requested', actionRequired: true, resolvedAt: null }).sort({ createdAt: 1 }).session(session).lean();
    if (rows.length !== ids.length) throw new Error('All selected records must be unresolved human-request reviews in this conversation. Safety and delivery exceptions cannot be merged.');
    if (new Set(rows.map(row => String(row.assignedTo || '')).filter(Boolean)).size > 1) throw new Error('Conflicting owners: review manually');
    const journey = conversation.orchestration?.recoveryJourneyKey || '';
    if (rows.some(row => row.metadata?.reviewJourneyKey !== undefined && row.metadata.reviewJourneyKey !== journey)) throw new Error('Different request journeys: cannot merge');
    const key = requestReviewKey(conversationId, journey);
    const keyed = await Alert.findOne({ business, dedupeKey: key }).session(session).lean();
    if (keyed && !ids.includes(String(keyed._id))) throw new Error('Include the current canonical review in --alerts');
    const canonical = keyed || rows.find(row => row.acknowledgedAt) || rows.find(row => row.assignedTo) || rows[0];
    const duplicates = rows.filter(row => String(row._id) !== String(canonical._id));
    console.log(JSON.stringify({ mode: session ? 'apply' : 'preview', canonical: canonical._id,
      superseded: duplicates.map(row => row._id), journey,
      warning: 'Confirm these selected records belong to this same customer request before applying.' }));
    if (!session) return;
    const ready = [...rows].reverse().find(row => row.metadata?.intakeReview) || rows.at(-1);
    const assigned = rows.find(row => row.assignedTo);
    const acknowledged = rows.find(row => row.acknowledgedAt);
    const events = rows.flatMap(row => [{ key: `legacy:${row._id}`, occurredAt: row.createdAt, title: row.title,
      message: row.message, messageId: row.metadata?.messageId, providerMessageId: row.metadata?.providerMessageId,
      priority: row.priority, handoffReason: row.metadata?.handoffReason }, ...(row.reviewEvents || [])]);
    const now = new Date();
    await Alert.updateOne({ _id: canonical._id, business }, { $set: {
      dedupeKey: key, title: ready.title, message: ready.message, recommendedAction: ready.recommendedAction,
      aiSummary: ready.aiSummary, lastCustomerMessage: ready.lastCustomerMessage,
      metadata: { ...canonical.metadata, ...ready.metadata, requestReview: true, reviewJourneyKey: journey },
      dueAt: rows.map(row => row.dueAt).filter(Boolean).sort((a,b) => new Date(a)-new Date(b))[0] || canonical.dueAt,
      reviewEvents: [...new Map(events.map(event => [event.key, event])).values()],
      reviewPhase: ready.metadata?.intakeReview ? 2 : 1, reviewLatestAt: ready.createdAt,
      priority: rows.some(row => row.priority === 'critical') ? 'critical' : rows.some(row => row.priority === 'high') ? 'high' : ready.priority,
      ...(assigned ? { assignedTo: assigned.assignedTo, assignedAt: assigned.assignedAt, assignedBy: assigned.assignedBy } : {}),
      ...(acknowledged ? { status: 'acknowledged', acknowledgedAt: acknowledged.acknowledgedAt, acknowledgedBy: acknowledged.acknowledgedBy } : {}),
    } }, { session, runValidators: true });
    await Conversation.updateOne({ _id: conversationId, business, 'conversationMemory.recoveryIntake.review.alertId': { $in: ids } },
      { $set: { 'conversationMemory.recoveryIntake.review.alertId': String(canonical._id) } }, { session });
    await Alert.updateMany({ _id: { $in: duplicates.map(row => row._id) }, business }, { $set: {
      status: 'resolved', resolvedAt: now, resolution: `Consolidated into review ${canonical._id}; customer request remains active there.`,
      'metadata.supersededBy': String(canonical._id), 'metadata.consolidatedAt': now,
    } }, { session });
  };
  if (args.includes('--apply')) await mongoose.connection.transaction(run);
  else await run(null);
} finally { await mongoose.disconnect(); }
