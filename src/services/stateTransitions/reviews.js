// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/controllers/intervention/Assignment.js:50 — findOneAndUpdate; predicate and write options are owned here.
export function assignOpenReview({ Alert, assignmentUpdate, business, req }) {
  return (Alert.findOneAndUpdate(
          {
            _id: req.params.id,
            business: business._id,
            resolvedAt: null,
          },
          { $set: assignmentUpdate },
          { returnDocument: "after", runValidators: true },
        ));
}

// src/controllers/intervention/Resolution.js:55 — findOneAndUpdate; predicate and write options are owned here.
export function acknowledgeOpenReview({ Alert, business, req, set }) {
  return (Alert.findOneAndUpdate(
          {
            _id: req.params.id,
            business: business._id,
            resolvedAt: null,
            acknowledgedAt: null,
          },
          { $set: set },
          { returnDocument: "after", runValidators: true },
        ));
}

// src/controllers/intervention/Resolution.js:137 — findOneAndUpdate; predicate and write options are owned here.
export function resolveOpenReview({ Alert, business, req, set }) {
  return (Alert.findOneAndUpdate(
          {
            _id: req.params.id,
            business: business._id,
            resolvedAt: null,
          },
          { $set: set },
          { returnDocument: "after", runValidators: true },
        ));
}

// src/controllers/intervention/context.js:93 — findOneAndUpdate; predicate and write options are owned here.
export function pauseOwnedReviewConversation({ Conversation, alert, business, normalizeId }) {
  return (Conversation.findOneAndUpdate({
      _id: normalizeId(alert.conversation), business: business._id,
    }, { $set: { humanTakeover: true, aiEnabled: false } }, { returnDocument: 'after' }));
}

// src/services/alert.service.js:167 — findOneAndUpdate; predicate and write options are owned here.
export function alertCreateAlertAtomicUpdate({ Alert, businessId, dueAt, existing, message, metadata, normalizePriority, priority, reason, recommendedAction, reopenedAt, staffReviewDueAt, title, truncate }) {
  return (Alert.findOneAndUpdate({
            _id: existing._id, business: businessId, resolvedAt: { $ne: null },
            'metadata.serviceEligibilityReason': { $exists: true },
          }, {
            $set: {
              actionRequired: true, resolvedAt: null, resolvedBy: null,
              resolution: '', status: 'sent', assignedTo: null,
              acknowledgedAt: null, acknowledgedBy: null,
              dueAt: dueAt || staffReviewDueAt(normalizePriority(priority), reopenedAt),
              title, message, reason: truncate(reason, 1000),
              recommendedAction: truncate(recommendedAction, 1000),
              'metadata.serviceEligibilityReason': metadata.serviceEligibilityReason,
            },
            $unset: { 'metadata.workflow': 1 },
            $push: { reviewEvents: {
              key: `service-review-reopened:${reopenedAt.getTime()}`,
              occurredAt: reopenedAt, title: 'Customer renewed the service review request',
              message: 'The previous review remains in history; staff must make a new decision.',
            } },
          }, { returnDocument: 'after', runValidators: true }));
}

// src/services/intervention.service.js:103 — create; predicate and write options are owned here.
export function interventionCreateAlertCreate({ Alert, payload }) {
  return (Alert.create(payload));
}

// src/services/interventionEscalation.service.js:16 — findOneAndUpdate; predicate and write options are owned here.
export function interventionEscalationEscalateOverdueInterventionsAlertAtomicUpdate({ Alert, candidate, dueAt, eligible }) {
  return (Alert.findOneAndUpdate({ ...eligible, _id: candidate._id, business: candidate.business, dueAt: null },
        { $set: { dueAt } }, { returnDocument: 'after', runValidators: true }));
}

// src/services/interventionEscalation.service.js:21 — findOneAndUpdate; predicate and write options are owned here.
export function interventionEscalationEscalateOverdueInterventionsAlertAtomicUpdate2({ Alert, candidate, eligible, now }) {
  return (Alert.findOneAndUpdate({ ...eligible, dueAt: { $lte: now, $ne: null }, _id: candidate._id, business: candidate.business }, {
      $set: { priority: "critical", "metadata.reviewEscalatedAt": now },
    }, { returnDocument: "after", runValidators: true }));
}

// src/services/opsPaging.service.js:11 — findOneAndUpdate; predicate and write options are owned here.
export function opsPagingPublishAlertAtomicUpdate({ Alert, current }) {
  return (Alert.findOneAndUpdate({ _id: current.alert, business: current.business,
      $or: [{ 'metadata.opsNotification.revision': { $exists: false } }, { 'metadata.opsNotification.revision': { $lte: current.revision } }] },
    { $set: { 'metadata.opsNotification': { status: current.status, action: current.desiredAction, revision: current.revision, updatedAt: current.updatedAt } } }, { returnDocument: 'after' }));
}

// src/services/opsPaging.service.js:62 — updateOne; predicate and write options are owned here.
export function opsPagingReconcileOpsAlertsAlertUpdateOne({ Alert, alert, now, unresolved }) {
  return (Alert.updateOne({ _id: alert._id, ...unresolved,  $or: [{ 'metadata.opsNotification': { $exists: false } }, { 'metadata.opsNotification.action': 'resolve' }] },
      { $set: { 'metadata.opsNotification': { status: 'pending', action: 'trigger', updatedAt: now } } }));
}

// src/services/requestReview.service.js:36 — updateOne; predicate and write options are owned here.
export function saveRequestReviewAlertUpdateOne({ Alert, event, eventKey, scope }) {
  return (Alert.updateOne({ ...scope, 'reviewEvents.key': { $ne: eventKey } }, { $push: { reviewEvents: event } }));
}

// src/services/requestReview.service.js:47 — updateOne; predicate and write options are owned here.
export function saveRequestReviewAlertUpdateOne2({ Alert, occurredAt, phase, scope, set }) {
  return (Alert.updateOne({ ...scope, resolvedAt: null, $and: [
    { $or: [{ reviewLatestAt: null }, { reviewLatestAt: { $lte: occurredAt } }] },
    { $or: [{ reviewPhase: null }, { reviewPhase: { $lte: phase } }] },
  ] }, { $set: set }));
}

// src/services/requestReview.service.js:52 — updateOne; predicate and write options are owned here.
export function saveRequestReviewAlertUpdateOne3({ Alert, payload, ranks, scope }) {
  return (Alert.updateOne({ ...scope, resolvedAt: null, priority: { $in: ranks.slice(0, ranks.indexOf(payload.priority)) } },
    { $set: { priority: payload.priority } }));
}

// src/services/revenueHumanRescue.service.js:15 — updateOne; predicate and write options are owned here.
export function revenueHumanRescueScanRevenueRescueDeadlinesAlertUpdateOne({ Alert, dedupeKey, now, row }) {
  return (Alert.updateOne({business:row.business,dedupeKey},{$setOnInsert:{business:row.business,
      dedupeKey,lead:row.lead||null,appointment:row.appointment||null,type:'unanswered_hot_lead',
      channel:'in_app',title:'Revenue opportunity needs follow-up',
      message:'An assigned or unclaimed recovery opportunity passed its follow-up deadline.',
      status:'sent',priority:'high',actionRequired:true,dueAt:row.dueAt,sentAt:now,
      metadata:{revenueRescueOpportunityId:String(row._id)}}},{upsert:true}));
}

// src/services/staffNotification.service.js:18 — findOneAndUpdate; predicate and write options are owned here.
export function staffNotificationPublishAlertAtomicUpdate({ Alert, current, field }) {
  return (Alert.findOneAndUpdate({ _id: current.alert, business: current.business,
    $or: [{ [`${field}.revision`]: { $exists: false } }, { [`${field}.revision`]: { $lte: current.revision } }],
  }, { $set: { [field]: { status: current.status, updatedAt: current.updatedAt, revision: current.revision } } }, { returnDocument: "after" }));
}

// src/services/staffSms.service.js:39 — updateOne; predicate and write options are owned here.
export function runStaffSmsAlertUpdateOne({ Alert, alert, path }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.state`]: 'sending' }, { $set: { [`${path}.state`]: 'uncertain' } }));
}

// src/services/staffSms.service.js:45 — findOneAndUpdate; predicate and write options are owned here.
export function runStaffSmsAlertAtomicUpdate({ Alert, alert, eligibleAttempt, now, path, token }) {
  return (Alert.findOneAndUpdate({ _id: alert._id, actionRequired: true, resolvedAt: null,
      acknowledgedAt: null, ...eligibleAttempt(path, now) },
      { $set: { [path]: { state: 'sending', at: now, token } } }, { returnDocument: "after" }));
}

// src/services/staffSms.service.js:60 — updateOne; predicate and write options are owned here.
export function runStaffSmsAlertUpdateOne2({ Alert, alert, path, token }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [`${path}.state`]: 'canceled' } }));
}

// src/services/staffSms.service.js:73 — updateOne; predicate and write options are owned here.
export function runStaffSmsAlertUpdateOne3({ Alert, alert, now, path, result, retryAt, state, token }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [path]: {
        state, at: now, retryAt, reason: result?.reason || '', providerMessageId: result?.sid || '',
      } } }));
}

// src/services/staffSms.service.js:79 — updateOne; predicate and write options are owned here.
export function runStaffSmsAlertUpdateOne4({ Alert, alert, error, now, path, token }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [path]: {
        state: error.deliveryUncertain ? 'uncertain' : 'failed', at: now, reason: String(error.code || error.message).slice(0, 200),
      } } }));
}
