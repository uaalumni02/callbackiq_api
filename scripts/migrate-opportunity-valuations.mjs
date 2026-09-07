import mongoose from 'mongoose';
const apply = process.argv.includes('--apply');
if (!process.env.MONGO_URL) throw new Error('MONGO_URL is required. Run with node --env-file=.env.');
await mongoose.connect(process.env.MONGO_URL);
try {
  for (const name of ['leads','appointments','voicesessions','conversionevents']) {
    const collection = mongoose.connection.db.collection(name);
    const filter = { $or: [{ 'valuation.source': { $exists: false } }, { 'valuation.source': null }] };
    const total = await collection.countDocuments(filter);
    console.log(`${apply ? 'APPLY' : 'DRY RUN'} ${name}: ${total} records need source labels. Existing amounts will be preserved.`);
    if (!apply || !total) continue;
    const result = await collection.updateMany(filter, [{ $set: {
      valuation: { source: { $cond: [{ $isNumber: '$estimatedValue' }, 'legacy_unverified', 'unknown'] }, basis: 'Legacy record; numerical amounts retained for owner review', updatedAt: '$$NOW', minimum: null, maximum: null, serviceOffering: null },
      valuationVersion: { $add: [{ $ifNull: ['$valuationVersion',0] },1] },
    } }]);
    console.log(`Labeled ${result.modifiedCount} records.`);
  }
  const ci = mongoose.connection.db.collection('conversationintelligences');
  const filter = { 'estimatedRevenue.source': { $exists: false } };
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} legacy intelligence snapshots: ${await ci.countDocuments(filter)}`);
  if (apply) await ci.updateMany(filter, { $set: { 'estimatedRevenue.source': 'legacy_unverified' } });
} finally { await mongoose.disconnect(); }
