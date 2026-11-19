import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';

const linkedRecords = { lead: 'leads', conversation: 'conversations', appointment: 'appointments' };
const actorFields = ['assignedTo', 'assignedBy', 'acknowledgedBy', 'resolvedBy'];
const selection = Object.fromEntries(['business', ...Object.keys(linkedRecords), ...actorFields].map(field => [field, 1]));
const byId = rows => new Map(rows.map(row => [String(row._id), row]));

async function readLinks(db, collection, ids, projection) {
  const keys = [...new Map(ids.filter(Boolean).map(id => [String(id), id])).values()];
  if (!keys.length) return new Map();
  return byId(await db.collection(collection).find({ _id: { $in: keys } }, { projection, maxTimeMS: 5000 }).toArray());
}

export async function auditAlertReferences(db) {
  const alerts = db.collection('alerts');
  const [last] = await alerts.find({}, { projection: { _id: 1 }, maxTimeMS: 5000 }).sort({ _id: -1 }).limit(1).toArray();
  const report = { checked: 0, foreign: 0, missing: 0, sample: [] };
  const flag = (alert, field, kind) => {
    report[kind]++;
    if (report.sample.length < 50) report.sample.push({ alertId: String(alert._id), field, kind });
  };

  let after;
  while (last) {
    const page = await alerts.find({ _id: { $lte: last._id, ...(after ? { $gt: after } : {}) } },
      { projection: selection, maxTimeMS: 5000 }).sort({ _id: 1 }).limit(250).toArray();
    if (!page.length) break;
    after = page.at(-1)._id;
    report.checked += page.length;

    const [businesses, users, ...records] = await Promise.all([
      readLinks(db, 'businesses', page.map(row => row.business), { owner: 1 }),
      readLinks(db, 'users', page.flatMap(row => actorFields.map(field => row[field])), { role: 1 }),
      ...Object.entries(linkedRecords).map(([field, collection]) =>
        readLinks(db, collection, page.map(row => row[field]), { business: 1 })),
    ]);

    for (const alert of page) {
      const business = businesses.get(String(alert.business));
      if (!business) flag(alert, 'business', 'missing');
      for (const [i, field] of Object.keys(linkedRecords).entries()) {
        if (alert[field] == null) continue;
        const record = records[i].get(String(alert[field]));
        if (!record) flag(alert, field, 'missing');
        else if (String(record.business) !== String(alert.business)) flag(alert, field, 'foreign');
      }
      for (const field of actorFields) {
        if (alert[field] == null) continue;
        const user = users.get(String(alert[field]));
        if (!user) flag(alert, field, 'missing');
        // Admins can act across tenants, but only the business owner can be assigned.
        else if (business && (field === 'assignedTo' || user.role !== 'admin') && String(user._id) !== String(business.owner)) {
          flag(alert, field, 'foreign');
        }
      }
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  const uri = getMongoUrl();
  if (!uri) throw new Error('Set MONGO_URL to a database with read-only audit credentials.');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    const report = await auditAlertReferences(mongoose.connection.db);
    console.log(JSON.stringify(report));
    if (report.foreign || report.missing) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
