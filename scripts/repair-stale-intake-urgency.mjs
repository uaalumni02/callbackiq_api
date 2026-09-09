import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
if (args.includes('--help')) {
  console.log('Usage: node scripts/repair-stale-intake-urgency.mjs --business-id <id> --since <ISO date> [--apply]\nDry-run by default. Uses MONGO_URL. Repairs only unresolved, evidence-backed post-intake safety escalations; preserves later staff edits.');
} else {
  const businessId = args.includes('--business-id') ? value('--business-id') : '';
  const since = args.includes('--since') ? new Date(value('--since')) : new Date(NaN);
  if (!mongoose.isObjectIdOrHexString(businessId) || !Number.isFinite(since.getTime())) throw new Error('--business-id and a valid --since ISO date are required');
  if (!process.env.MONGO_URL) throw new Error('MONGO_URL is required');
  const apply = args.includes('--apply');
  await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 10000 });
  try {
    const db = mongoose.connection.db;
    const business = new mongoose.Types.ObjectId(businessId);
    const alerts = await db.collection('alerts').find({ business, type: 'safety_emergency', resolvedAt: null,
      createdAt: { $gte: since }, 'metadata.handoffReason': 'intake_follow_up', 'metadata.messageCategory': 'emergency' }).sort({ createdAt: -1 }).limit(500).toArray();
    const repairs = [];
    const seen = new Set();
    for (const alert of alerts) {
      const [lead, conversation] = await Promise.all([
        db.collection('leads').findOne({ _id: alert.lead, business }),
        db.collection('conversations').findOne({ _id: alert.conversation, business }),
      ]);
      if (!lead || !conversation || String(conversation.lead) !== String(lead._id)) continue;
      if (new Date(conversation.orchestration?.recoveryJourneyStartedAt || 0) > alert.createdAt) continue;
      if (lead.urgency !== 'emergency' && (!lead.updatedAt || lead.updatedAt <= alert.createdAt) && !seen.has(`lead:${lead._id}`)) {
        seen.add(`lead:${lead._id}`);
        repairs.push({ collection: 'leads', id: lead._id, business, updatedAt: lead.updatedAt, field: 'urgency', before: lead.urgency ?? null, evidenceAlert: alert._id });
      }
      if (conversation.conversationMemory?.urgency !== 'emergency' && new Date(conversation.conversationMemory?.lastUpdatedAt || 0) <= alert.createdAt && !seen.has(`conversation:${conversation._id}`)) {
        seen.add(`conversation:${conversation._id}`);
        repairs.push({ collection: 'conversations', id: conversation._id, business, updatedAt: conversation.updatedAt, field: 'conversationMemory.urgency', before: conversation.conversationMemory?.urgency ?? null, evidenceAlert: alert._id });
      }
    }
    console.log(`${apply ? 'Apply' : 'Dry run'}: ${repairs.length} eligible field repairs from ${alerts.length} unresolved safety alerts (maximum 500).`);
    if (apply && repairs.length) {
      const backup = path.resolve('.callbackiq-fix-backups', `urgency-${Date.now()}.json`);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, JSON.stringify(repairs, null, 2), { mode: 0o600, flag: 'wx' });
      let modified = 0;
      for (const repair of repairs) {
        const result = await db.collection(repair.collection).updateOne({ _id: repair.id, business, updatedAt: repair.updatedAt ?? null, [repair.field]: repair.before }, { $set: { [repair.field]: 'emergency' }, $currentDate: { updatedAt: true } });
        modified += result.modifiedCount;
      }
      console.log(`Repaired ${modified} fields. Concurrently changed records were skipped. Backup: ${backup}`);
    }
  } finally { await mongoose.disconnect(); }
}
