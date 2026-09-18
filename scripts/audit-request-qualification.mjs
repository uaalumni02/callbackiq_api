#!/usr/bin/env node
// Read-only rollout audit. Never fills in missing coverage or sends a message.
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';
import { evaluateServiceAreaPolicy } from '../src/services/scheduling/serviceAreaPolicy.service.js';
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : '';
const businessId = value('--business-id');
const postalCode = value('--postal-code');
if (!mongoose.isValidObjectId(businessId) || (postalCode && !/^\d{5}(?:-\d{4})?$/.test(postalCode))) {
  console.error('Usage: node scripts/audit-request-qualification.mjs --business-id OBJECT_ID [--postal-code ZIP]');
  process.exitCode = 1;
} else {
  try {
    await mongoose.connect(getMongoUrl(), { autoIndex: false, autoCreate: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    const id = new mongoose.Types.ObjectId(businessId);
    const business = await db.collection('businesses').findOne({ _id: id }, { projection: { businessName: 1, owner: 1 }, maxTimeMS: 5000 });
    if (!business) throw new Error('Business not found');
    const [area, owner, workers, notificationCounts] = await Promise.all([
      db.collection('serviceareas').findOne({ business: id }, { maxTimeMS: 5000 }),
      db.collection('users').findOne({ _id: business.owner }, { projection: { email: 1, emailVerifiedAt: 1 }, maxTimeMS: 5000 }),
      db.collection('processheartbeats').find({ seenAt: { $gte: new Date(Date.now() - 90000) } }, { projection: { role: 1, ready: 1, seenAt: 1, release: 1 }, maxTimeMS: 5000 }).limit(100).toArray(),
      db.collection('staffnotificationjobs').aggregate([{ $match: { business: id } }, { $group: { _id: '$status', count: { $sum: 1 } } }], { maxTimeMS: 5000 }).toArray(),
    ]);
    const coverageConfigured = area?.type === 'unrestricted' ||
      (area?.type === 'zip_codes' && Array.isArray(area.zipCodes) && area.zipCodes.length > 0 && area.zipCodes.every(zip => /^\d{5}(?:-\d{4})?$/.test(zip))) ||
      (area?.type === 'radius' && /^\d{5}(?:-\d{4})?$/.test(area.centerPostalCode || '') && Number(area.radiusMiles) > 0 && Number(area.radiusMiles) <= 500);
    const emailEnabled = process.env.STAFF_NOTIFICATION_EMAIL_ENABLED === 'true';
    const verifiedRecipient = Boolean(owner?.email && owner.emailVerifiedAt);
    const issues = [!coverageConfigured && 'Coverage must be explicitly configured before appointment options can be offered.',
      !emailEnabled && 'Staff notification email is disabled in this process environment; verify the deployed worker configuration.',
      !verifiedRecipient && 'A verified owner email is required by the current staff email dispatcher.',
      !workers.some(worker => worker.ready && /worker/.test(worker.role)) && 'No recent ready worker heartbeat was found.',
      notificationCounts.some(row => ['failed', 'uncertain'].includes(row._id)) && 'Failed or uncertain staff notifications require review.'].filter(Boolean);
    const sampleCoverage = postalCode ? await evaluateServiceAreaPolicy({ area, postalCode }) : null;
    if (sampleCoverage?.supported !== true && sampleCoverage) issues.push(`Sample address coverage: ${sampleCoverage.reason}`);
    console.log(JSON.stringify({ businessId, businessName: business.businessName, coverageConfigured: Boolean(coverageConfigured),
      coverageMode: area?.type || 'missing', emailEnabled, verifiedRecipient, recentWorkers: workers,
      notificationCounts, sampleCoverage, issues,
      note: 'Configuration evidence only. Provider acceptance is not delivery or staff acknowledgment. Verify a staged SMS and voice journey through actual approval and notification.' }, null, 2));
    if (issues.length) process.exitCode = 2;
  } catch (error) {
    console.error(`Audit could not complete (${error.name || 'Error'}). Check database access and business ID.`);
    process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
