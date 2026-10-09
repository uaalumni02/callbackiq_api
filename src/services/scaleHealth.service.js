import Appointment from '../models/appointment.js';
import { unresolvedNoticeFailureFilter } from './scheduling/appointmentNoticeFailure.service.js';
import AppointmentNotice from '../models/appointmentNotificationJob.js';
import SmsJob from '../models/smsProcessingJob.js';
import WebhookWork from '../models/webhookWork.js';
import Heartbeat from '../models/processHeartbeat.js';
import Incident from '../models/opsIncident.js';
import Notification from '../models/staffNotificationJob.js';
const age = (date, now) => date ? Math.max(0, now - new Date(date).getTime()) : 0;
export async function readScaleHealth({ now = new Date() } = {}) {
  const [sms, recovery, heartbeats, failedPages, uncertainEmail, appointmentNotice, unresolvedAppointmentNotices, stalledAppointmentProjections] = await Promise.all([
    SmsJob.findOne({ status: { $in: ['queued', 'retry', 'processing'] } }).sort({ createdAt: 1 }).select('createdAt').maxTimeMS(3000).lean(),
    WebhookWork.findOne({ status: { $in: ['queued', 'processing'] } }).sort({ createdAt: 1 }).select('createdAt').maxTimeMS(3000).lean(),
    Heartbeat.aggregate([{ $match: { ready: true, seenAt: { $gte: new Date(now - 45000) } } }, { $group: { _id: '$role', count: { $sum: 1 }, releases: { $addToSet: '$release' }, capacityPlans: { $addToSet: '$capacityPlan' }, images: { $addToSet: '$image' } } }]).option({ maxTimeMS: 3000 }),
    Incident.countDocuments({ status: 'failed' }).maxTimeMS(3000),
    Notification.aggregate([
      { $match: { status: { $in: ['failed', 'uncertain'] } } },
      { $lookup: { from: 'alerts', let: { alertId: '$alert', businessId: '$business' }, pipeline: [
        { $match: { actionRequired: true, acknowledgedAt: null, resolvedAt: null,
          $expr: { $and: [{ $eq: ['$_id', '$$alertId'] }, { $eq: ['$business', '$$businessId'] }] } } },
        { $project: { _id: 1 } },
      ], as: 'openReview' } },
      { $match: { 'openReview.0': { $exists: true } } }, { $count: 'count' },
    ]).option({ maxTimeMS: 3000 }).then(rows => rows[0]?.count || 0),
    AppointmentNotice.findOne({ status: { $in: ['scheduled', 'processing'] }, scheduledFor: { $lte: now } }).sort({ scheduledFor: 1 }).select('scheduledFor').maxTimeMS(3000).lean(),
    AppointmentNotice.countDocuments(unresolvedNoticeFailureFilter(now)).maxTimeMS(3000),
    Appointment.countDocuments({ $or: ['bookingProjection', 'completionProjection'].map(field => ({
      [`${field}.pending`]: true, [`${field}.at`]: { $lte: new Date(now - 120000) },
    })) }).maxTimeMS(3000),
  ]);
  const roles = Object.fromEntries(heartbeats.map(row => [row._id, row.count]));
  const required = process.env.SCALE_PROFILE ? { api: Number(process.env.API_INSTANCE_COUNT),
    voice: Number(process.env.SCALE_VOICE_REPLICAS) - 1, 'worker-sms': Number(process.env.SCALE_SMS_REPLICAS),
    'worker-ops': 1, 'worker-maintenance': 1, 'worker-automation': 1, 'worker-a2p': 1,
    'worker-lifecycle': 1, 'worker-voice-usage': 1 } : {};
  const missingRoles = Object.entries(required).filter(([role, count]) => !(roles[role] >= count)).map(([role]) => role);
  const smsOldestAgeMs = age(sms?.createdAt, now), recoveryOldestAgeMs = age(recovery?.createdAt, now);
  const appointmentNoticeOldestAgeMs = age(appointmentNotice?.scheduledFor, now);
  const automationWorkerReady = ['all', 'worker', 'worker-automation'].some(role => roles[role] > 0);
  const unhealthy = stalledAppointmentProjections > 0 || unresolvedAppointmentNotices > 0 || !automationWorkerReady || appointmentNoticeOldestAgeMs > 120000 || missingRoles.length > 0 || failedPages > 0 || uncertainEmail > 0 || smsOldestAgeMs > 60000 || recoveryOldestAgeMs > 30000;
  return { timestamp: now.toISOString(), healthy: !unhealthy, automationWorkerReady, roles, required, missingRoles,
    releases: [...new Set(heartbeats.flatMap(x => x.releases))],
    capacityPlans: [...new Set(heartbeats.flatMap(x => x.capacityPlans || ['unrecorded']))],
    images: [...new Set(heartbeats.flatMap(x => x.images || ['unrecorded']))],
    smsOldestAgeMs, recoveryOldestAgeMs, appointmentNoticeOldestAgeMs, failedPages, uncertainEmail, unresolvedAppointmentNotices, stalledAppointmentProjections };
}
