// Dry-run by default. No texts or calendar calls. Run from the API directory.
import 'dotenv/config';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { getMongoUrl, normalizeRuntimeEnvironment } from '../src/config/runtime-environment.js';
normalizeRuntimeEnvironment();
const apply = process.argv.includes('--apply');
if (!getMongoUrl()) throw new Error('MongoDB connection is not configured.');
await mongoose.connect(getMongoUrl(), { autoIndex: false, autoCreate: false });
try {
  const db = mongoose.connection;
  const appointments = db.collection('appointments');
  let links = 0, reviews = 0;
  for await (const original of appointments.find({ status: 'rescheduled', rescheduledTo: { $ne: null } })) {
    const replacement = await appointments.findOne({ _id: original.rescheduledTo, business: original.business, status: 'confirmed' });
    if (!replacement) continue;
    const filter = { _id: original.conversation, business: original.business, 'bookingState.appointment': original._id };
    if (original.conversation && await db.collection('conversations').findOne(filter)) {
      links++;
      if (apply) await db.collection('conversations').updateOne(filter, { $set: { 'bookingState.appointment': replacement._id, 'bookingState.status': 'booked', 'bookingState.lastError': '', 'bookingState.expiresAt': null } });
    }
  }
  for await (const alert of db.collection('alerts').find({ dedupeKey: /^ai_reschedule_approval:/, resolvedAt: null }).sort({ createdAt: -1 })) {
    const id = alert.metadata?.appointmentId;
    if (!mongoose.isValidObjectId(id)) continue;
    const appointment = await appointments.findOne({ _id: new mongoose.Types.ObjectId(id), business: alert.business, status: 'confirmed' });
    const startAt = new Date(alert.metadata?.requestedStartAt), endAt = new Date(alert.metadata?.requestedEndAt);
    if (!appointment || appointment.rescheduleRequest?.id || !Number.isFinite(+startAt) || +startAt <= Date.now() || !(endAt > startAt)) continue;
    reviews++;
    if (apply) await appointments.updateOne({ _id: appointment._id, 'rescheduleRequest.id': { $exists: false } }, { $set: {
      rescheduleRequest: { id: crypto.randomUUID(), status: 'pending', startAt, endAt, requestedAt: alert.createdAt || new Date(), channel: alert.metadata?.channel || 'sms', alertPending: true },
    } });
  }
  if (apply) {
    await appointments.createIndex({ 'lifecycleNotice.pending': 1, updatedAt: 1 });
    await appointments.createIndex({ 'rescheduleRequest.alertPending': 1, updatedAt: 1 });
    await db.collection('appointmentnotificationjobs').createIndex({ business: 1, providerMessageId: 1 });
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', conversationLinks: links, legacyChangeRequests: reviews,
    note: 'No customer texts sent. Recovered requests are published to staff by appointment maintenance after deployment.' }, null, 2));
} finally { await mongoose.disconnect(); }
