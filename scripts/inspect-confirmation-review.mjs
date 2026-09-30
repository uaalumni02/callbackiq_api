import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUrl } from '../src/config/runtime-environment.js';

// Read-only, tenant-scoped inspection. Does not create indexes or send messages.
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--help') || !args.includes('--business') || !args.includes('--conversation')) {
  console.log('Usage: node scripts/inspect-confirmation-review.mjs --business BUSINESS_ID --conversation CONVERSATION_ID\nRun from the API directory with its environment configured. Read-only; no messages are sent.');
  process.exit(args.includes('--help') ? 0 : 1);
}
let connection;
try {
  const businessId = value('--business'), conversationId = value('--conversation');
  if (![businessId, conversationId].every(id => /^[a-f0-9]{24}$/i.test(id || ''))) throw new Error('IDs must be 24 hexadecimal characters.');
  const uri = getMongoUrl();
  if (!uri) throw new Error('Configure MONGODB_URI, MONGO_URL, or MONGO_URI.');
  connection = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 }).asPromise();
  const db = connection.db, business = new mongoose.Types.ObjectId(businessId), conversation = new mongoose.Types.ObjectId(conversationId);
  const options = { maxTimeMS: 5000 };
  const record = await db.collection('conversations').findOne({ _id: conversation, business }, { ...options, projection: { bookingState: 1, orchestration: 1, 'conversationMemory.recoveryIntake.review': 1 } });
  if (!record) throw new Error('Conversation not found in the specified business.');
  const ownerBusiness = await db.collection('businesses').findOne({ _id: business }, { ...options, projection: { owner: 1, isActive: 1 } });
  const owner = ownerBusiness?.owner && await db.collection('users').findOne({ _id: ownerBusiness.owner }, { ...options, projection: { email: 1, emailVerifiedAt: 1 } });
  const alerts = await db.collection('alerts').find({ business, conversation }, { ...options, projection: { actionRequired: 1, acknowledgedAt: 1, resolvedAt: 1, dueAt: 1, priority: 1, 'metadata.approvalRequest': 1, 'metadata.handoffReason': 1 } }).sort({ createdAt: -1 }).limit(100).toArray();
  const jobs = await db.collection('staffnotificationjobs').find({ business, alert: { $in: alerts.map(a => a._id) } }, { ...options, projection: { alert: 1, stage: 1, status: 1, attempts: 1, lastError: 1, updatedAt: 1 } }).limit(300).toArray();
  const review = record.conversationMemory?.recoveryIntake?.review;
  const linked = alerts.find(a => String(a._id) === String(review?.alertId));
  console.log(JSON.stringify({
    scope: { businessId, conversationId },
    emailEnabledInThisProcess: process.env.STAFF_NOTIFICATION_EMAIL_ENABLED === 'true',
    businessActive: ownerBusiness?.isActive === true,
    verifiedOwnerEmailPresent: Boolean(owner?.email && owner?.emailVerifiedAt),
    review: { status: review?.status || 'missing', linkedAlertExists: Boolean(linked), linkedAlertActionRequired: linked?.actionRequired === true },
    bookingStatus: record.bookingState?.status || 'missing',
    appointmentId: record.bookingState?.appointment || null,
    handoffStatus: record.orchestration?.handoffStatus || 'missing',
    alerts, notificationJobs: jobs,
    interpretation: 'Queued means stored; accepted means email provider acceptance, not inbox delivery or staff acknowledgment. No appointment ID can be normal for a manual intake request. Missing jobs require checking worker configuration and logs. This process environment may differ from the deployed worker. Results include at most 100 recent alerts.'
  }, null, 2));
} catch (error) {
  // Do not echo database connection errors that can expose connection details.
  console.error(error.name?.startsWith('Mongo') ? 'Database inspection failed. Check connectivity and read permissions.' : error.message);
  process.exitCode = 1;
} finally { if (connection) await connection.close(); }
