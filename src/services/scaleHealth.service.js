import SmsJob from '../models/smsProcessingJob.js';
import WebhookWork from '../models/webhookWork.js';
import Heartbeat from '../models/processHeartbeat.js';
import Incident from '../models/opsIncident.js';
import Notification from '../models/staffNotificationJob.js';
const age = (date, now) => date ? Math.max(0, now - new Date(date).getTime()) : 0;
export async function readScaleHealth({ now = new Date() } = {}) {
  const [sms, recovery, heartbeats, failedPages, uncertainEmail] = await Promise.all([
    SmsJob.findOne({ status: { $in: ['queued', 'retry', 'processing'] } }).sort({ createdAt: 1 }).select('createdAt').maxTimeMS(3000).lean(),
    WebhookWork.findOne({ status: { $in: ['queued', 'processing'] } }).sort({ createdAt: 1 }).select('createdAt').maxTimeMS(3000).lean(),
    Heartbeat.aggregate([{ $match: { ready: true, seenAt: { $gte: new Date(now - 45000) } } }, { $group: { _id: '$role', count: { $sum: 1 }, releases: { $addToSet: '$release' }, capacityPlans: { $addToSet: '$capacityPlan' }, images: { $addToSet: '$image' } } }]).option({ maxTimeMS: 3000 }),
    Incident.countDocuments({ status: 'failed' }).maxTimeMS(3000),
    Notification.countDocuments({ status: { $in: ['failed', 'uncertain'] } }).maxTimeMS(3000),
  ]);
  const roles = Object.fromEntries(heartbeats.map(row => [row._id, row.count]));
  const required = process.env.SCALE_PROFILE ? { api: Number(process.env.API_INSTANCE_COUNT),
    voice: Number(process.env.SCALE_VOICE_REPLICAS) - 1, 'worker-sms': Number(process.env.SCALE_SMS_REPLICAS),
    'worker-ops': 1, 'worker-maintenance': 1, 'worker-automation': 1, 'worker-a2p': 1,
    'worker-lifecycle': 1, 'worker-voice-usage': 1 } : {};
  const missingRoles = Object.entries(required).filter(([role, count]) => !(roles[role] >= count)).map(([role]) => role);
  const smsOldestAgeMs = age(sms?.createdAt, now), recoveryOldestAgeMs = age(recovery?.createdAt, now);
  const unhealthy = missingRoles.length > 0 || failedPages > 0 || smsOldestAgeMs > 60000 || recoveryOldestAgeMs > 30000;
  return { timestamp: now.toISOString(), healthy: !unhealthy, roles, required, missingRoles,
    releases: [...new Set(heartbeats.flatMap(x => x.releases))],
    capacityPlans: [...new Set(heartbeats.flatMap(x => x.capacityPlans || ['unrecorded']))],
    images: [...new Set(heartbeats.flatMap(x => x.images || ['unrecorded']))],
    smsOldestAgeMs, recoveryOldestAgeMs, failedPages, uncertainEmail };
}
