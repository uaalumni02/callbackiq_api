// Saves, inserts and tracked query/bulk mutations refresh the affected leads.
// The projection writes Inbox flags and last inbound activity. A transactional
// projection uses the write's session and propagates failure for rollback.
// Outside a transaction, log projection failures and preserve the write result.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { logOperationalError } from '../../helpers/logging/safeLogger.js';
import { ACTIVE_LEAD_STATUSES, opportunityFlags, ownerInterventionFilter } from '../scale/leadWorkflowPolicy.js';
import { queryBudgetMs } from '../scale/queryBudget.js';

export const LEAD_INACTIVITY_ARCHIVE_DAYS = 30;
const active = { $in: ACTIVE_LEAD_STATUSES };
const trackedFields = {
  Lead: ['status', 'serviceNeeded', 'address', 'preferredAppointmentTime', 'serviceEligibility'],
  Conversation: ['lead', 'status', 'lastMessageAt', 'updatedAt', 'humanTakeover', 'bookingState', 'conversationMemory', 'serviceEligibility'],
  Appointment: ['lead', 'status', 'startAt', 'failureReason'],
  Alert: ['lead', 'resolvedAt', 'type', 'priority', 'metadata', 'actionRequired'],
};
const activityModels = new Set(['Message', 'CallLog']);
const insertSession = new AsyncLocalStorage();
const bookingStatuses = ['held', 'confirmed'];
const futureAppointmentStatuses = [...bookingStatuses, 'cancel_pending'];
const MAX_BATCH = 100;
const selection = '_id business lead conversation direction from status createdAt updatedAt';

const validId = id => mongoose.isObjectIdOrHexString(id);
const oid = id => new mongoose.Types.ObjectId(String(id));

export async function recomputeLeadWorkflowFlags(businessId, leadId, { session } = {}) {
  if (!validId(businessId) || !validId(leadId)) return;
  const { Lead, Conversation, Appointment, Alert } = mongoose.models;
  if (!Lead || !Conversation || !Appointment || !Alert || Lead.db.readyState !== 1) return;
  const scope = { _id: oid(leadId), business: oid(businessId) };
  const revision = randomUUID();
  const options = { session, maxTimeMS: queryBudgetMs() };

  // A newer write owns the projection if it starts while this one is reading.
  const claimed = await Lead.collection.updateOne(scope, {
    $set: { workflowFlagsRevision: revision, workflowFlagsPending: true },
  }, options);
  if (!claimed.matchedCount) return;
  // The business-wide AI booking switch gates readiness in the read query.
  // The stored flags describe the lead independent of that live switch.
  const [row] = await Lead.aggregate([
    { $match: scope },
    ...opportunityFlags(scope.business, ownerInterventionFilter(scope.business)),
    { $project: { _id: 0, ready: '$_ready', needsMe: '$_needsMe', waiting: '$_isWaiting' } },
  ]).option(options);

  // Keep the lead's update timestamp and pagination order independent of projection writes.
  if (row) await Lead.collection.updateOne({ ...scope, workflowFlagsRevision: revision }, {
    $set: { workflowFlags: { ...row, computedAt: new Date() } },
    $unset: { workflowFlagsPending: '' },
  }, options);
}

function inboundActivityWrite(filter, at) {
  return {
    filter: { ...filter, $or: [{ lastInboundActivityAt: null }, { lastInboundActivityAt: { $lt: at } }] },
    update: [{ $set: {
      lastInboundActivityAt: at,
      workflowFlagsRevision: randomUUID(),
      archivedAt: { $cond: [{ $lte: ['$archivedAt', at] }, null, '$archivedAt'] },
      archiveReason: { $cond: [{ $lte: ['$archivedAt', at] }, '$$REMOVE', '$archiveReason'] },
    } }],
  };
}

async function recordInboundActivity(modelName, record, session) {
  const { Lead, Conversation } = mongoose.models;
  const businessId = record.business?._id || record.business;
  if (!Lead || !validId(businessId)) return;
  const booking = modelName === 'Appointment';
  if (booking ? !bookingStatuses.includes(record.status) : record.direction !== 'inbound') return;
  const at = booking ? record.updatedAt : record.createdAt;
  if (!(at instanceof Date)) return;

  let leadId = record.lead?._id || record.lead;
  if (!leadId && record.conversation && Conversation) {
    const linked = await Conversation.findOne({ _id: record.conversation, business: businessId })
      .select('lead').session(session || null).maxTimeMS(queryBudgetMs()).lean();
    leadId = linked?.lead;
  }
  const filter = { business: oid(businessId) };
  if (validId(leadId)) filter._id = oid(leadId);
  else if (modelName === 'CallLog' && record.from) filter.phone = record.from;
  else return;

  const write = inboundActivityWrite(filter, at);
  await Lead.collection.updateOne(write.filter, write.update, { session, maxTimeMS: queryBudgetMs() });
}

function writeSession(model, options) {
  return Object.hasOwn(options ?? {}, 'session')
    ? options.session
    : model.db.base.transactionAsyncLocalStorage?.getStore()?.session;
}

async function projectAfterWrite(session, project, context) {
  try {
    await project();
  } catch (error) {
    if (session?.inTransaction()) throw error;
    logOperationalError('lead.workflow_flags.failed', error, context);
  }
}

async function projectRecords(modelName, records, session, activity = false) {
  const targets = new Map();
  for (const record of records) {
    if (!record) continue;
    if (activity) await projectAfterWrite(session, () => recordInboundActivity(modelName, record, session), {
      modelName, businessId: record.business, leadId: record.lead,
    });
    const lead = modelName === 'Lead' ? record._id : record.lead;
    if (record.business && lead && !activityModels.has(modelName)) {
      targets.set(`${record.business}:${lead}`, [record.business, lead]);
    }
  }
  for (const [business, lead] of targets.values()) {
    await projectAfterWrite(session, () => recomputeLeadWorkflowFlags(business, lead, { session }), {
      businessId: business, leadId: lead,
    });
  }
}

function pathsChanged(update, fields) {
  if (Array.isArray(update)) return true;
  return Object.entries(update || {}).some(([key, value]) => {
    const paths = key.startsWith('$') ? Object.keys(value || {}) : [key];
    return paths.some(path => fields.some(field => path === field || path.startsWith(`${field}.`)));
  });
}

export function installLeadWorkflowWriter(schema, modelName) {
  const inbound = activityModels.has(modelName);
  const fields = trackedFields[modelName] || [];
  schema.pre('save', function () {
    this.$locals.projectLeadWorkflow = this.isNew || fields.some(field => this.isModified(field));
    this.$locals.recordLeadActivity = this.isNew || (modelName === 'Appointment' && ['status', 'startAt', 'lead'].some(field => this.isModified(field)));
  });
  schema.post('save', async function (doc) {
    if (doc.constructor.db.readyState !== 1 || !doc.$locals.projectLeadWorkflow) return;
    const previous = doc.$locals.leadWorkflowReference;
    await projectRecords(modelName, [doc], doc.$session(), doc.$locals.recordLeadActivity);
    if (previous && String(previous.lead) !== String(doc.lead)) {
      await projectRecords(modelName, [previous], doc.$session());
    }
    doc.$locals.leadWorkflowReference = { business: doc.business, lead: doc.lead };
  });
  schema.post('init', function (doc) {
    doc.$locals.leadWorkflowReference = { business: doc.business, lead: doc.lead };
  });
  // Mongoose's insertMany hooks receive only the rows. Scope the options to this
  // call so concurrent lean and hydrated inserts cannot borrow another session.
  schema.statics.insertMany = function (docs, options) {
    return insertSession.run(writeSession(this, options), () => mongoose.Model.insertMany.call(this, docs, options));
  };
  schema.post('insertMany', async function (docs) {
    if (this.db.readyState === 1) await projectRecords(modelName, docs, insertSession.getStore(), true);
  });

  installQueryWriters(schema, modelName, inbound, fields);
  if (modelName === 'Conversation') {
    // SMS ingress updates conversation snapshots in bulk. Refresh both sides
    // of any lead relink. The result is computed from the persisted records.
    schema.statics.bulkWrite = async function (operations, options) {
      const native = () => mongoose.Model.bulkWrite.call(this, operations, options);
      const updates = operations.map(operation => operation.updateOne).filter(Boolean);
      if (!updates.length || this.db.readyState !== 1) return native();
      const session = writeSession(this, options);
      const before = await this.find({ $or: updates.map(row => row.filter) }).select('business lead')
        .session(session || null).maxTimeMS(queryBudgetMs()).lean();
      const targets = updates.map(row => ({ business: row.filter.business, lead: row.update.$set?.lead }));
      try {
        return await native();
      } finally {
        await projectRecords(modelName, [...before, ...targets], session);
      }
    };
  }
}

function installQueryWriters(schema, modelName, inbound, fields) {
  const operations = inbound ? ['findOneAndUpdate', 'updateOne'] :
    ['findOneAndUpdate', 'updateOne', 'updateMany', 'findOneAndDelete', 'deleteOne', 'deleteMany', 'replaceOne', 'findOneAndReplace'];
  schema.pre(operations, async function () {
    if (this.model.db.readyState !== 1) return;
    const options = this.getOptions();
    const update = this.getUpdate();
    const deleting = this.op.includes('Delete') || this.op.startsWith('delete');
    const inserting = Boolean(options.upsert);
    const replacing = this.op.toLowerCase().includes('replace');
    if (inbound ? !inserting : !deleting && !inserting && !replacing && !pathsChanged(update, fields)) return;
    const session = writeSession(this.model, options);
    const many = this.op.endsWith('Many');
    const before = inbound ? [] : await this.model.find(this.getFilter()).select(selection).sort(options.sort || {})
      .limit(many ? 0 : 1).session(session || null).maxTimeMS(queryBudgetMs()).lean();
    this.leadWorkflowWrite = {
      before, deleting, inserting, session,
      reload: replacing || inserting || pathsChanged(update, ['lead']),
      activity: modelName === 'Appointment' && !deleting && (inserting || replacing || pathsChanged(update, ['status', 'startAt', 'lead'])),
    };
  });
  schema.post(operations, async function (result) {
    if (!this.leadWorkflowWrite) return;
    const { before, deleting, inserting, session, reload, activity } = this.leadWorkflowWrite;
    if (result?.acknowledged === false || result?.matchedCount === 0 && !result.upsertedId ||
        result?.deletedCount === 0 || result === null && !inserting) return;
    await projectAfterWrite(session, async () => {
      const insertedId = result?.upsertedId || result?.lastErrorObject?.upserted;
      if (inbound && result?.business && result?.createdAt) {
        return projectRecords(modelName, [result], session, true);
      }
      const ids = insertedId ? [insertedId] : before.map(record => record._id);
      if (ids.length === 0 && result?._id) ids.push(result._id);
      const after = !deleting && (reload || activity) && (ids.length || inserting)
        ? await this.model.find(ids.length ? { _id: { $in: ids } } : this.getFilter()).select(selection)
          .limit(ids.length || 1).session(session || null).maxTimeMS(queryBudgetMs()).lean()
        : [];
      if (activity || inbound) await projectRecords(modelName, after, session, true);
      const changedReferences = before.filter(old => !after.some(current =>
        String(current._id) === String(old._id) && String(current.lead) === String(old.lead)));
      await projectRecords(modelName, activity || inbound ? changedReferences : [...before, ...after], session);
    }, { modelName, operation: this.op });
  });
}

export async function recordInboundMessageActivities(messages) {
  const { Lead } = mongoose.models;
  if (!Lead) return;
  const latest = new Map();
  for (const message of messages) {
    if (message.direction !== 'inbound' || !(message.createdAt instanceof Date)) continue;
    if (!validId(message.lead) || !validId(message.business)) {
      await recordInboundActivity('Message', message);
      continue;
    }
    const key = `${message.business}:${message.lead}`;
    if (!latest.has(key) || latest.get(key).createdAt < message.createdAt) latest.set(key, message);
  }
  if (!latest.size) return;
  const operations = [...latest.values()].map(message => ({ updateOne: inboundActivityWrite(
    { _id: oid(message.lead), business: oid(message.business) }, message.createdAt,
  ) }));
  await Lead.collection.bulkWrite(operations, { ordered: false });
}

function inactivityCutoff(now) {
  const override = Number(process.env.LEAD_INACTIVITY_ARCHIVE_DAYS);
  const days = Number.isFinite(override) && override > 0 ? override : LEAD_INACTIVITY_ARCHIVE_DAYS;
  return new Date(+now - days * 86400000);
}

const inactiveScope = cutoff => ({
  status: active,
  archivedAt: null,
  updatedAt: { $lte: cutoff },
  $or: [{ lastInboundActivityAt: null }, { lastInboundActivityAt: { $lte: cutoff } }],
});

export async function archiveInactiveLead(lead, now = new Date()) {
  const { Lead, Alert, Appointment, Message, CallLog } = mongoose.models;
  const scope = { business: lead.business, lead: lead._id };
  const cutoff = inactivityCutoff(now);
  if (!ACTIVE_LEAD_STATUSES.includes(lead.status) || lead.archivedAt ||
      +lead.updatedAt > +cutoff || +lead.lastInboundActivityAt > +cutoff) return false;

  const openIntervention = ownerInterventionFilter(lead.business);
  const protection = [
    Alert.exists({ ...scope, resolvedAt: null, $or: [...openIntervention.$or, { actionRequired: true }] }),
    Appointment.exists({ ...scope, startAt: { $gt: now }, status: { $in: futureAppointmentStatuses } }),
    Message.exists({ ...scope, direction: 'inbound', createdAt: { $gt: cutoff } }),
    CallLog.exists({ ...scope, direction: 'inbound', createdAt: { $gt: cutoff } }),
  ];
  if ((await Promise.all(protection.map(query => query.maxTimeMS(queryBudgetMs())))).some(Boolean)) return false;

  const result = await Lead.collection.updateOne({
    _id: lead._id, business: lead.business, ...inactiveScope(cutoff),
    workflowFlagsRevision: lead.workflowFlagsRevision ?? null,
  }, { $set: { archivedAt: now, archiveReason: 'inactive' } }, { maxTimeMS: queryBudgetMs() });
  return result.modifiedCount === 1;
}

export async function sweepLeadWorkflow({ now = new Date(), after } = {}) {
  const { Lead } = mongoose.models;
  if (Lead?.db.readyState !== 1) return;
  const pending = await Lead.find({ workflowFlagsPending: true }).sort({ _id: 1 })
    .select('business').limit(MAX_BATCH).maxTimeMS(queryBudgetMs()).lean();
  await projectRecords('Lead', pending);

  const leads = await Lead.find({ ...inactiveScope(inactivityCutoff(now)), ...(after ? { _id: { $gt: after } } : {}) })
    .sort({ _id: 1 }).limit(MAX_BATCH).maxTimeMS(queryBudgetMs()).lean();
  for (const lead of leads) await archiveInactiveLead(lead, now);
  return leads.length === MAX_BATCH ? leads.at(-1)._id : undefined;
}
