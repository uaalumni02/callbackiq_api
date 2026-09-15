import crypto from 'node:crypto';
import Incident from '../models/opsIncident.js';
import Alert from '../models/alert.js';
import SocketService from './socket.service.js';
const enabled = () => process.env.OPS_PAGING_ENABLED === 'true';
const unresolved = { actionRequired: true, acknowledgedAt: null, resolvedAt: null };
const publish = async id => {
  const current = await Incident.findById(id).lean();
  if (!current) return;
  if (current.alert) {
    const alert = await Alert.findOneAndUpdate({ _id: current.alert, business: current.business,
      $or: [{ 'metadata.opsNotification.revision': { $exists: false } }, { 'metadata.opsNotification.revision': { $lte: current.revision } }] },
    { $set: { 'metadata.opsNotification': { status: current.status, action: current.desiredAction, revision: current.revision, updatedAt: current.updatedAt } } }, { returnDocument: 'after' });
    if (alert) SocketService.emitAlertUpdated(current.business, alert);
  }
  await Incident.updateOne({ _id: current._id, revision: current.revision, status: current.status }, { $set: { published: true } });
};

// The fixed endpoint prevents a configured webhook from becoming an SSRF path.
// PagerDuty dedup_key makes a timeout/retry one incident, not a new page identity.
export async function sendOpsEvent({ key, action, reason, fetcher = fetch }) {
  if (!process.env.PAGERDUTY_ROUTING_KEY) throw Object.assign(new Error('Operations paging not configured'), { code: 'OPS_NOT_CONFIGURED' });
  const response = await fetcher('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routing_key: process.env.PAGERDUTY_ROUTING_KEY, event_action: action,
      dedup_key: `${process.env.SCALE_CACHE_NAMESPACE || 'callbackiq'}:${key}`,
      ...(action === 'trigger' ? { payload: { summary: `CallBackIQ requires operator review: ${reason}`,
        source: 'callbackiq', severity: 'critical' } } : {}) }),
  });
  if (response.status !== 202) throw Object.assign(new Error('Operations provider rejected event'), { code: `OPS_HTTP_${response.status}` });
  const result = await response.json();
  if (result.status !== 'success') throw Object.assign(new Error('Operations acceptance unverified'), { code: 'OPS_ACCEPTANCE_UNVERIFIED' });
}

export async function setOpsIncident({ key, active, reason, alert, business }) {
  if (!enabled()) return;
  const desiredAction = active ? 'trigger' : 'resolve';
  if (active) {
    try { await Incident.updateOne({ _id: key }, { $setOnInsert: { desiredAction, reason, alert, business,
      status: 'pending', nextAttemptAt: new Date() } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  await Incident.updateOne({ _id: key, desiredAction: { $ne: desiredAction } }, {
    $set: { desiredAction, status: 'pending', published: false, attempts: 0, nextAttemptAt: new Date(), reason }, $inc: { revision: 1 },
  });
}

export async function reconcileOpsAlerts({ now = new Date(), limit = 100 } = {}) {
  if (!enabled()) return;
  const alerts = await Alert.find({ ...unresolved, priority: { $in: ['high', 'critical'] },
    'metadata.opsNotification': { $exists: false }, $or: [
      { dueAt: { $ne: null, $lte: now } },
      { dueAt: null, createdAt: { $lte: new Date(now - 300000) } },
      { 'metadata.staffNotification.initial.status': { $in: ['failed', 'uncertain'] } },
      { 'metadata.staffNotification.overdue.status': { $in: ['failed', 'uncertain'] } },
    ],
  }).sort({ dueAt: 1, _id: 1 }).limit(limit).select('_id business').lean();
  for (const alert of alerts) {
    await setOpsIncident({ key: `review:${alert._id}`, active: true, reason: 'unacknowledged_customer_review', alert: alert._id, business: alert.business });
    await Alert.updateOne({ _id: alert._id, ...unresolved, 'metadata.opsNotification': { $exists: false } },
      { $set: { 'metadata.opsNotification': { status: 'pending', updatedAt: now } } });
  }
  // Rotate fairly through open incidents, including ones whose page was accepted.
  const incidents = await Incident.find({ desiredAction: 'trigger', alert: { $ne: null } }).sort({ checkedAt: 1, _id: 1 }).limit(limit).lean();
  for (const incident of incidents) {
    const open = await Alert.exists({ _id: incident.alert, business: incident.business, ...unresolved });
    if (!open) await setOpsIncident({ key: incident._id, active: false, reason: 'review_closed' });
    await Incident.updateOne({ _id: incident._id }, { $set: { checkedAt: now } });
  }
}

export async function dispatchOpsEvents({ limit = 25, send = sendOpsEvent } = {}) {
  if (!enabled()) return { processed: 0 };
  for (const job of await Incident.find({ published: false }).sort({ updatedAt: 1 }).limit(limit).lean()) await publish(job._id);
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const now = new Date(), token = crypto.randomUUID();
    const job = await Incident.findOneAndUpdate({ $or: [
      { status: 'pending', nextAttemptAt: { $lte: now } }, { status: 'sending', leaseUntil: { $lte: now } },
    ] }, { $set: { status: 'sending', published: false, leaseToken: token, leaseUntil: new Date(Date.now() + 30000) }, $inc: { attempts: 1, revision: 1 } },
    { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: 'after' });
    if (!job) break;
    let status = 'accepted', lastErrorCode = '';
    try { await send({ key: job._id, action: job.desiredAction, reason: job.reason }); }
    catch (error) {
      lastErrorCode = String(error.code || 'OPS_NETWORK_ERROR').slice(0, 80);
      status = job.attempts >= 20 ? 'failed' : 'pending';
    }
    const result = await Incident.updateOne({ _id: job._id, leaseToken: token, revision: job.revision, status: 'sending' }, {
      $set: { status, published: false, lastErrorCode, nextAttemptAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(job.attempts, 6))) },
      $unset: { leaseUntil: 1, leaseToken: 1 },
    });
    if (result.modifiedCount) await publish(job._id);
    processed++;
  }
  return { processed };
}
