// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/scheduling/appointment.service.js:174 — create; predicate and write options are owned here.
export function reserveAppointmentSlot({ Appointment, baseDocument, capacityLane, endAt, getSlotClaimKeys, getSlotKey, startAt }) {
  return (Appointment.create({
        ...baseDocument,
        capacityLane,
        activeSlotKey: `${getSlotKey(startAt, endAt)}|lane:${capacityLane}`,
        slotClaimKeys: getSlotClaimKeys({
          startAt,
          endAt,
          bufferBeforeMinutes: baseDocument.bufferBeforeMinutes,
          bufferAfterMinutes: baseDocument.bufferAfterMinutes,
          capacityLane,
        }),
      }));
}

// src/services/scheduling/appointment.service.js:363 — assignment; predicate and write options are owned here.
export function stageDeclinedAppointment({ appointment }) {
  return (appointment.status = "failed");
}

// src/services/scheduling/appointmentConfirmation.service.js:35 — updateOne; predicate and write options are owned here.
export function queueMissingConfirmationReview({ Alert, appointment }) {
  return (Alert.updateOne({ business: appointment.business,
      dedupeKey: `appointment_confirmation_missing:${appointment._id}` }, { $setOnInsert: {
      business: appointment.business, appointment: appointment._id, conversation: appointment.conversation || null,
      lead: appointment.lead || null, type: 'integration_failure', channel: 'in_app', priority: 'high',
      status: 'sent', actionRequired: true, sentAt: new Date(),
      title: 'Appointment confirmation needs verification',
      message: 'The visit start time has passed and its confirmation was not queued. Verify the customer outcome; no stale confirmation was sent.',
      recommendedAction: 'Contact the customer and record the outcome.',
      metadata: { appointmentId: String(appointment._id), confirmationRecovery: true },
    } }, { upsert: true }));
}

// src/services/scheduling/appointmentConfirmationIntent.repository.js:39 — findOneAndUpdate; predicate and write options are owned here.
export function patchOwnedConfirmationIntent({ Appointment, appointment, fields, options, owned }) {
  return (Appointment.findOneAndUpdate(owned(appointment), { $set: fields }, options));
}

// src/services/scheduling/appointmentConfirmationIntent.repository.js:44 — findOneAndUpdate; predicate and write options are owned here.
export function beginConfirmationIntent({ Appointment, appointment, approvedBy, lease, now, options, provider, slotIdentity }) {
  return (Appointment.findOneAndUpdate({
        ...slotIdentity(appointment),
        status: 'held',
        $or: [{ heldExpiresAt: null }, { heldExpiresAt: { $gt: now } }],
        'confirmationIntent.status': { $ne: 'pending_provider' },
        ...(appointment.updatedAt ? { updatedAt: appointment.updatedAt } : {}),
      }, { $set: { confirmationIntent: {
        key: `${appointment.business}:${appointment._id}`,
        status: 'pending_provider',
        requestedAt: now,
        nextAttemptAt: now,
        approvedBy,
        provider,
        attempts: 0,
        ...lease(now),
      } } }, options));
}

// src/services/scheduling/appointmentConfirmationIntent.repository.js:73 — findOneAndUpdate; predicate and write options are owned here.
export function claimDueConfirmationIntent({ Appointment, appointment, due, leaseUntil, now, options, slotIdentity, token }) {
  return (Appointment.findOneAndUpdate({
        ...slotIdentity(appointment),
        status: appointment.status,
        'confirmationIntent.status': appointment.confirmationIntent.status,
        ...due(now),
      }, { $set: { 'confirmationIntent.token': token, 'confirmationIntent.leaseUntil': leaseUntil } }, options));
}

// src/services/scheduling/appointmentConfirmationIntent.repository.js:87 — findOneAndUpdate; predicate and write options are owned here.
export function finishConfirmationEffects({ Appointment, appointment, options, owned }) {
  return (Appointment.findOneAndUpdate(owned(appointment), {
        $set: { 'confirmationIntent.effectsPending': false },
        $unset: { 'confirmationIntent.nextAttemptAt': '', 'confirmationIntent.token': '', 'confirmationIntent.leaseUntil': '' },
      }, options));
}

// src/services/scheduling/appointmentHoldExpiry.service.js:11 — updateMany; predicate and write options are owned here.
export function expireUnclaimedHolds({ Appointment, query }) {
  return (Appointment.updateMany(query, {
      $set: {
        status: "failed",
        activeSlotKey: null,
        slotClaimKeys: [],
        capacityLane: null,
        failureReason: "Appointment hold expired before confirmation.",
        "approvalRecovery.reconciled": false,
        "approvalRecovery.expiredAt": new Date(),
      },
    }));
}

// src/services/scheduling/appointmentLifecycle.service.js:34 — updateOne; predicate and write options are owned here.
export function repairAppointmentLifecycleAppointmentUpdateOne({ Appointment, filter }) {
  return (Appointment.updateOne(filter, { $set: { 'lifecycleNotice.pending': false, 'lifecycleNotice.lastError': 'Superseded by appointment state.' } }));
}

// src/services/scheduling/appointmentLifecycle.service.js:44 — updateOne; predicate and write options are owned here.
export function repairAppointmentLifecycleAppointmentUpdateOne2({ Appointment, appointment, original }) {
  return (Appointment.updateOne({ _id: original._id, business: appointment.business, status: 'confirmed' }, { $set: {
      status: 'rescheduled', rescheduledTo: appointment._id, activeSlotKey: null, slotClaimKeys: [], capacityLane: null,
      externalAppointmentId: null, externalCalendarId: null,
      ...(original.rescheduleRequest?.status === 'pending' ? { 'rescheduleRequest.status': 'approved', 'rescheduleRequest.decidedAt': new Date(), 'rescheduleRequest.alertPending': true } : {}),
    } }));
}

// src/services/scheduling/appointmentLifecycle.service.js:52 — updateOne; predicate and write options are owned here.
export function repairAppointmentLifecycleLeadUpdateOne({ Lead, appointment, original }) {
  return (Lead.updateOne({ _id: appointment.lead, business: appointment.business, appointment: original._id },
      { $set: { appointment: appointment._id, bookedAt: appointment.confirmedAt } }));
}

// src/services/scheduling/appointmentLifecycle.service.js:59 — updateOne; predicate and write options are owned here.
export function repairAppointmentLifecycleLeadUpdateOne2({ Lead, appointment }) {
  return (Lead.updateOne({ _id: appointment.lead, business: appointment.business, appointment: appointment._id }, { $set: { appointment: null } }));
}

// src/services/scheduling/appointmentLifecycle.service.js:65 — updateOne; predicate and write options are owned here.
export function repairAppointmentLifecycleAppointmentUpdateOne3({ Appointment, filter }) {
  return (Appointment.updateOne(filter, { $set: { 'lifecycleNotice.pending': false, 'lifecycleNotice.lastError': '' } }));
}

// src/services/scheduling/appointmentLifecycle.service.js:72 — updateOne; predicate and write options are owned here.
export function tryRepairAppointmentLifecycleAppointmentUpdateOne({ Appointment, appointment, error }) {
  return (Appointment.updateOne({ _id: appointment._id, 'lifecycleNotice.key': appointment.lifecycleNotice?.key },
      { $set: { 'lifecycleNotice.lastError': String(error.message).slice(0, 300) } }));
}

// src/services/scheduling/appointmentLifecycle.service.js:84 — findOneAndUpdate; predicate and write options are owned here.
export function appointmentLifecycleDeclineRescheduleRequestAppointmentAtomicUpdate({ Appointment, appointmentId, business, lifecycleMarker, reason, requestId }) {
  return (Appointment.findOneAndUpdate({ _id: appointmentId, business: business._id, status: 'confirmed',
    'rescheduleRequest.id': requestId, 'rescheduleRequest.status': 'pending' }, { $set: {
    'rescheduleRequest.status': 'declined', 'rescheduleRequest.decidedAt': new Date(), 'rescheduleRequest.reason': String(reason).slice(0, 500),
    'rescheduleRequest.alertPending': true, lifecycleNotice: lifecycleMarker(`change_declined_${requestId}`),
  } }, { returnDocument: "after" }));
}

// src/services/scheduling/appointmentNoticeFailure.service.js:51 — updateMany; predicate and write options are owned here.
export function appointmentNoticeFailureResolveNoticeFailureAlertUpdateMany({ Alert, businessId, job, now }) {
  return (Alert.updateMany({ business: businessId, dedupeKey: `appointment_notice_failure:${job._id}`, resolvedAt: null },
    { $set: { resolvedAt: now, actionRequired: false } }));
}

// src/services/scheduling/appointmentNotification.service.js:306 — updateOne; predicate and write options are owned here.
export function appointmentNotificationStoreOutboundMessageConversationUpdateOne({ Conversation, appointment, body, business }) {
  return (Conversation.updateOne(
    { _id: appointment.conversation, business: business._id },
    { $set: { lastMessage: body, lastMessageAt: new Date() } },
  ));
}

// src/services/scheduling/appointmentProjection.service.js:24 — updateOne; predicate and write options are owned here.
export function appointmentProjectionRepairOneLeadUpdateOne({ Lead, appointment }) {
  return (Lead.updateOne({ _id: appointment.lead, business: appointment.business, appointment: appointment._id }, { $set: { appointment: null } }));
}

// src/services/scheduling/appointmentProjection.service.js:48 — updateOne; predicate and write options are owned here.
export function appointmentProjectionRepairOneLeadUpdateOne2({ Lead, appointment, marker }) {
  return (Lead.updateOne({ _id: appointment.lead, business: appointment.business,
      $or: [{ completionProjectionAt: null }, { completionProjectionAt: { $lte: marker.at } }],
    }, { $set: { completedAt: appointment.completedAt, actualRevenue: appointment.actualRevenue,
      completionProjectionAt: marker.at } }));
}

// src/services/scheduling/appointmentProjection.service.js:57 — updateMany; predicate and write options are owned here.
export function appointmentProjectionRepairOneAlertUpdateMany({ Alert, appointment, field, marker }) {
  return (Alert.updateMany({ business: appointment.business, dedupeKey: `appointment_projection:${appointment._id}:${field}:${marker.token}`, resolvedAt: null },
    { $set: { resolvedAt: new Date(), actionRequired: false } }));
}

// src/services/scheduling/appointmentProjection.service.js:59 — updateOne; predicate and write options are owned here.
export function appointmentProjectionRepairOneAppointmentUpdateOne({ Appointment, appointment, field, scoped }) {
  return (Appointment.updateOne(scoped(appointment, field), {
    $set: { [`${field}.pending`]: false, [`${field}.lastError`]: '' },
  }));
}

// src/services/scheduling/appointmentProjection.service.js:82 — updateOne; predicate and write options are owned here.
export function appointmentProjectionTransitionAppointmentUpdateOne({ Appointment, appointment, field, lastError, scoped }) {
  return (Appointment.updateOne(scoped(appointment, field), { $set: {
            [`${field}.lastError`]: lastError, [`${field}.retryAt`]: new Date(Date.now() + 60000),
          } }));
}

// src/services/scheduling/appointmentReply.service.js:29 — updateOne; predicate and write options are owned here.
export function handleAppointmentReplyAppointmentUpdateOne({ Appointment, appointment, business, confirm }) {
  return (Appointment.updateOne({ _id: appointment._id, business: business._id, status: 'confirmed' }, {
    $set: confirm ? { customerConfirmedAt: new Date() } : { customerRescheduleRequestedAt: new Date() },
  }));
}

// src/services/scheduling/approvalLifecycle.service.js:17 — findOneAndUpdate; predicate and write options are owned here.
export function approvalLifecycleEnsureApprovalReviewAlertAtomicUpdate({ Alert, appointment, business, dueAt, expired }) {
  return (Alert.findOneAndUpdate({ business: appointment.business,
    dedupeKey: `appointment_approval_required:${appointment._id}` }, {
    $setOnInsert: { type: 'system', channel: 'in_app', status: 'sent', sentAt: new Date(),
      priority: 'medium', assignedTo: business.owner, assignedAt: new Date(),
      'metadata.approvalRequest': true },
    $set: { actionRequired: true, appointment: appointment._id,
      lead: appointment.lead || null, conversation: appointment.conversation || null,
      title: expired ? 'Appointment request needs an availability recheck' : 'Appointment approval required',
      message: expired ? 'The temporary reservation expired. The customer request remains open; check availability before approving.'
        : 'The customer selected a time. Approve or decline this request before its temporary reservation expires.',
      recommendedAction: expired ? 'Recheck the requested time or contact the customer to agree another time.' : 'Review and approve the customer’s selected time.',
      'metadata.appointmentId': String(appointment._id),
      'metadata.approvalState': expired ? 'needs_recheck' : 'pending',
      ...(expired ? { dueAt, resolvedAt: null, acknowledgedAt: null } : {}),
    },
  }, { upsert: true, returnDocument: "after" }));
}

// src/services/scheduling/approvalLifecycle.service.js:34 — updateOne; predicate and write options are owned here.
export function approvalLifecycleEnsureApprovalReviewAlertUpdateOne({ Alert, alert, dueAt }) {
  return (Alert.updateOne({ _id: alert._id, dueAt: null }, { $set: { dueAt } }));
}

// src/services/scheduling/approvalLifecycle.service.js:35 — updateOne; predicate and write options are owned here.
export function approvalLifecycleEnsureApprovalReviewAlertUpdateOne2({ Alert, alert, business }) {
  return (Alert.updateOne({ _id: alert._id, assignedTo: null }, { $set: { assignedTo: business.owner, assignedAt: new Date() } }));
}

// src/services/scheduling/approvalLifecycle.service.js:36 — updateOne; predicate and write options are owned here.
export function approvalLifecycleEnsureApprovalReviewAlertUpdateOne3({ Alert, alert }) {
  return (Alert.updateOne({ _id: alert._id }, { $set: { 'metadata.approvalRequest': true } }));
}

// src/services/scheduling/approvalLifecycle.service.js:56 — updateOne; predicate and write options are owned here.
export function approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne({ Appointment, appointment }) {
  return (Appointment.updateOne({ _id: appointment._id, status: appointment.status }, { $set: { 'approvalRecovery.reconciled': true, 'approvalRecovery.state': 'resolved' } }));
}

// src/services/scheduling/approvalLifecycle.service.js:65 — updateOne; predicate and write options are owned here.
export function approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne2({ Appointment, appointment, expired }) {
  return (Appointment.updateOne({ _id: appointment._id, status: appointment.status }, { $set: {
        'approvalRecovery.reconciled': true, 'approvalRecovery.state': expired ? 'needs_recheck' : 'pending',
      } }));
}

// src/services/scheduling/approvalLifecycle.service.js:76 — updateOne; predicate and write options are owned here.
export function approvalLifecycleReconcileApprovalRequestsAppointmentUpdateOne3({ Appointment, appointment, error }) {
  return (Appointment.updateOne({ _id: appointment._id }, { $set: { 'approvalRecovery.lastError': String(error.code || error.message).slice(0, 200) } }));
}

// src/services/scheduling/approvalLifecycle.service.js:83 — updateMany; predicate and write options are owned here.
export function approvalLifecycleResolveApprovalReviewAlertUpdateMany({ Alert, appointment }) {
  return (Alert.updateMany({ business: appointment.business, 'metadata.appointmentId': String(appointment._id),
    'metadata.approvalRequest': true, resolvedAt: null }, { $set: {
    resolvedAt: new Date(), status: 'resolved', actionRequired: false,
    resolution: `Appointment ${appointment.status}`, 'metadata.approvalState': appointment.status,
  } }));
}

// src/services/scheduling/approvalSms.service.js:43 — updateOne; predicate and write options are owned here.
export function runApprovalSmsAlertUpdateOne({ Alert, alert, path }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.state`]: 'sending' }, { $set: { [`${path}.state`]: 'uncertain' } }));
}

// src/services/scheduling/approvalSms.service.js:49 — findOneAndUpdate; predicate and write options are owned here.
export function runApprovalSmsAlertAtomicUpdate({ Alert, alert, eligibleAttempt, now, path, token }) {
  return (Alert.findOneAndUpdate({ _id: alert._id, actionRequired: true, resolvedAt: null,
      acknowledgedAt: null, ...eligibleAttempt(path, now) },
      { $set: { [path]: { state: 'sending', at: now, token } } }, { returnDocument: "after" }));
}

// src/services/scheduling/approvalSms.service.js:65 — updateOne; predicate and write options are owned here.
export function runApprovalSmsAlertUpdateOne2({ Alert, alert, now, path, result, retryAt, state, token }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [path]: {
        state, at: now, retryAt, reason: result?.reason || '', providerMessageId: result?.sid || '',
      } } }));
}

// src/services/scheduling/approvalSms.service.js:71 — updateOne; predicate and write options are owned here.
export function runApprovalSmsAlertUpdateOne3({ Alert, alert, error, now, path, token }) {
  return (Alert.updateOne({ _id: alert._id, [`${path}.token`]: token }, { $set: { [path]: {
        state: error.deliveryUncertain ? 'uncertain' : 'failed', at: now, reason: String(error.code || error.message).slice(0, 200),
      } } }));
}

// src/services/scheduling/reschedule/followUp.js:18 — updateOne; predicate and write options are owned here.
export function followUpTaskLeadUpdateOne({ Lead, business, replacement }) {
  return (Lead.updateOne({ _id: replacement.lead, business: business._id },
      { $set: { appointment: replacement._id, bookedAt: replacement.confirmedAt } }));
}

// src/services/scheduling/rescheduleRequest.service.js:28 — updateOne; predicate and write options are owned here.
export function rescheduleRequestEnsureRescheduleReviewAppointmentUpdateOne({ Appointment, appointment, request }) {
  return (Appointment.updateOne({ _id: appointment._id, 'rescheduleRequest.id': request.id },
    { $set: { 'rescheduleRequest.alertPending': false } }));
}

// src/services/scheduling/rescheduleRequest.service.js:33 — updateMany; predicate and write options are owned here.
export function rescheduleRequestResolveRescheduleReviewsAlertUpdateMany({ Alert, appointment, requestId }) {
  return (Alert.updateMany({ business: appointment.business, appointment: appointment._id,
    'metadata.rescheduleRequest': true, ...(requestId ? { 'metadata.requestId': requestId } : {}), resolvedAt: null },
  { $set: { resolvedAt: new Date(), status: 'resolved', actionRequired: false, resolution: 'Appointment change reviewed' } }));
}

// src/services/scheduling/rescheduleRequest.service.js:49 — findOneAndUpdate; predicate and write options are owned here.
export function submitRescheduleRequestAppointmentAtomicUpdate({ Appointment, appointmentId, business, channel, crypto, endAt, startAt }) {
  return (Appointment.findOneAndUpdate({ _id: appointmentId, business: business._id,
      status: 'confirmed', 'rescheduleRequest.status': { $ne: 'pending' } }, { $set: {
      customerRescheduleRequestedAt: new Date(), rescheduleRequest: { id: crypto.randomUUID(), status: 'pending',
        startAt, endAt, channel, requestedAt: new Date(), alertPending: true },
    } }, { returnDocument: "after", runValidators: true }));
}

// src/services/scheduling/rescheduleRequest.service.js:70 — updateOne; predicate and write options are owned here.
export function rescheduleRequestRepairRescheduleReviewsAppointmentUpdateOne({ Appointment, row }) {
  return (Appointment.updateOne({ _id: row._id, 'rescheduleRequest.id': row.rescheduleRequest.id }, { $set: { 'rescheduleRequest.alertPending': false } }));
}

// src/services/scheduling/rescheduleRequest.service.js:73 — updateOne; predicate and write options are owned here.
export function rescheduleRequestRepairRescheduleReviewsAppointmentUpdateOne2({ Appointment, error, row }) {
  return (Appointment.updateOne({ _id: row._id, 'rescheduleRequest.id': row.rescheduleRequest.id }, { $set: { 'rescheduleRequest.lastError': String(error.message).slice(0, 300) } }));
}
