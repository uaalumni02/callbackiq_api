import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const pairs = [
 ['conversation', 'lead', 'lead'], ['callLog', 'lead', 'lead'], ['callLog', 'conversation', 'conversation'],
 ['message', 'conversation', 'conversation'], ['message', 'lead', 'lead'],
 ['smsProcessingJob', 'lead', 'lead'], ['smsProcessingJob', 'conversation', 'conversation'],
 ['appointmentNotificationJob', 'appointment', 'appointment'], ['automationJob', 'lead', 'lead'],
 ['automationJob', 'conversation', 'conversation'], ['appointment', 'lead', 'lead'],
 ['appointment', 'conversation', 'conversation'], ['alert', 'lead', 'lead'],
];
const args = process.argv.slice(2), limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 1000;
if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('--limit must be 1–100000 per relationship');
const files = [...new Set(pairs.flatMap(([model, , foreign]) => [model, foreign]))];
for (const file of files) await import(`../src/models/${file}.js`);
const byCollection = new Map(Object.values(mongoose.models).map(model => [model.modelName.toLowerCase(), model]));
const model = file => byCollection.get(file.toLowerCase());
try {
 await mongoose.connect(getMongoUrl(), { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
 for (const [source, reference, target] of pairs) {
  const parent = model(source), child = model(target);
  if (!parent || !child) throw new Error(`Unresolved model ${source}/${target}`);
  const cursor = parent.find({ [reference]: { $ne: null } }).select(`_id business ${reference}`)
   .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(10000).lean().cursor({ batchSize: 100 });
  let checked = 0, mismatches = 0;
  for await (const row of cursor) {
   if (checked === limit) break;
   checked++;
   const linked = await child.findById(row[reference]).select('_id business').maxTimeMS(3000).lean();
   if (!linked || String(linked.business) !== String(row.business)) {
    mismatches++;
    console.log(JSON.stringify({ type: 'invalid_tenant_link', model: parent.modelName, id: String(row._id),
      businessId: String(row.business), reference, foreignId: String(row[reference]), reason: linked ? 'tenant_mismatch' : 'missing_reference' }));
   }
  }
  console.log(JSON.stringify({ type: 'scan_summary', model: parent.modelName, reference, checked, mismatches, limitReached: checked === limit }));
 }
} finally { await mongoose.disconnect(); }
