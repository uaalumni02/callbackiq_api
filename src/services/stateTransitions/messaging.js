// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/messaging/compoundCustomerTurn.service.js:101 — set; predicate and write options are owned here.
export function setCompoundTurnMemory({ conversation, next }) {
  return (conversation.set('conversationMemory.recoveryIntake', next));
}

// src/services/messaging/compoundCustomerTurn.service.js:102 — assignment; predicate and write options are owned here.
export function replaceCompoundTurnMemory({ conversation, next }) {
  return (conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: next });
}

// src/services/messaging/conversationLeadIdentity.service.js:28 — findOneAndUpdate; predicate and write options are owned here.
export function relinkConversationLead({ Conversation, bookingTransitionFields, business, conversation, customerPhone, lead }) {
  return (Conversation.findOneAndUpdate({
        _id: conversation._id, business: business._id,
        lead: conversation.lead || null, customerPhone: customerPhone,
      }, { $set: { lead: lead._id, ...bookingTransitionFields('conversation_lead_relinked'),
        "conversationMemory.recoveryIntake": {} }, $unset: { serviceEligibility: 1 } },
      { returnDocument: "after", runValidators: true }));
}

// src/services/messaging/customerRequestRevision.service.js:26 — set; predicate and write options are owned here.
export function setRevisedRequestMemory({ conversation, intake }) {
  return (conversation.set('conversationMemory.recoveryIntake', intake));
}

// src/services/messaging/customerRequestRevision.service.js:27 — assignment; predicate and write options are owned here.
export function replaceRevisedRequestMemory({ conversation, intake }) {
  return (conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: intake });
}

// src/services/messaging/idempotentInboundSmsReply.service.js:222 — findByIdAndUpdate; predicate and write options are owned here.
export function persistIdempotentReplySummary({ Conversation, conversation, reply, sent }) {
  return (Conversation.findByIdAndUpdate(
        conversation._id,
        {
          lastMessage: sent?.body || reply,
          lastMessageAt: new Date(),
        },
        { returnDocument: "after" },
      ));
}

// src/services/messaging/inboundSmsDeterministicActions.service.js:43 — findByIdAndUpdate; predicate and write options are owned here.
export function persistSmsContactControl({ Conversation, contactKind, conversation, inboundMessage, saved }) {
  return (Conversation.findByIdAndUpdate(conversation._id, { $set: {
      'conversationMemory.recoveryIntake.contactControl.request': {
        kind: contactKind, alertId: String(saved.alert._id), inboundMessageId: String(inboundMessage._id),
        requestedAt: new Date(), callbackPhone: conversation.customerPhone,
      },
    } }, { returnDocument: 'after', runValidators: true }));
}

// src/services/messaging/inboundSmsDeterministicActions.service.js:63 — findByIdAndUpdate; predicate and write options are owned here.
export function persistSmsTakeoverControl({ Conversation, conversation, inboundMessage }) {
  return (Conversation.findByIdAndUpdate(conversation._id, { $set: {
      'conversationMemory.recoveryIntake.contactControl.receiptReply': {
        at: new Date(), inboundMessageId: String(inboundMessage._id),
      },
    } }, { runValidators: true }));
}

// src/services/messaging/inboundSmsDeterministicActions.service.js:96 — findByIdAndUpdate; predicate and write options are owned here.
export function persistInterruptedLeadRequest({ Lead, interruptUpdates, lead }) {
  return (Lead.findByIdAndUpdate(lead._id, interruptUpdates, { returnDocument: "after", runValidators: true }));
}

// src/services/messaging/inboundSmsDeterministicActions.service.js:98 — findByIdAndUpdate; predicate and write options are owned here.
export function persistInterruptedConversationRequest({ Conversation, buildSmsStatePatch, classification, conversation, directResult, revisionPatch }) {
  return (Conversation.findByIdAndUpdate(conversation._id, { $set: { ...buildSmsStatePatch({ conversation, classification,
      outcome: { intent: directResult.messageCategory }, hasCustomerReply: true }), ...revisionPatch } }, { runValidators: true }));
}

// src/services/messaging/inboundSmsJobProcessor.service.js:207 — findByIdAndUpdate; predicate and write options are owned here.
export function persistStaffFollowUpLead({ Lead, facts, lead, urgency }) {
  return (Lead.findByIdAndUpdate(lead._id,
    { $set: { ...facts, urgency } }, { returnDocument: "after", runValidators: true }));
}

// src/services/messaging/inboundSmsJobProcessor.service.js:211 — findByIdAndUpdate; predicate and write options are owned here.
export function persistStaffFollowUpConversation({ Conversation, conversation, inboundMessage, intent, urgency }) {
  return (Conversation.findByIdAndUpdate(conversation._id, {
    $set: {
      "conversationMemory.urgency": urgency,
      "conversationMemory.lastIntent": intent,
      "conversationMemory.lastUpdatedAt": new Date(),
      "orchestration.lastIntent": intent,
      "orchestration.lastOutcome": "queued_for_team",
      "orchestration.lastInboundMessage": inboundMessage._id,
      "orchestration.lastCustomerTurnAt": new Date(),
    },
  }, { returnDocument: "after", runValidators: true }));
}

// src/services/messaging/inboundSmsReply.service.js:67 — findByIdAndUpdate; predicate and write options are owned here.
export function persistReplyLeadFacts({ Lead, lead, leadUpdates }) {
  return (Lead.findByIdAndUpdate(lead._id, leadUpdates, {
      returnDocument: "after",
      runValidators: true,
    }));
}

// src/services/messaging/inboundSmsReply.service.js:108 — findByIdAndUpdate; predicate and write options are owned here.
export function persistReplyConversationState({ Conversation, handoffRequired, pendingHandoffPatch, result, revisionPatch, statePatch, updatedConversation }) {
  return (Conversation.findByIdAndUpdate(
    updatedConversation._id,
    { $set: { ...statePatch, ...revisionPatch, ...pendingHandoffPatch,
      ...(handoffRequired && !revisionPatch['conversationMemory.recoveryIntake'] ? { 'conversationMemory.recoveryIntake.preparedHandoffResult': {
        reply: result.reply, intakeCompletionReply: result.reply, intakeReview: result.intakeReview,
        messageCategory: result.messageCategory, serviceNeeded: result.serviceNeeded, urgency: result.urgency,
        address: result.address, preferredAppointmentTime: result.preferredAppointmentTime, summary: result.summary,
        guardrail: result.guardrail,
      } } : {}),
    } },
    { returnDocument: "after", runValidators: true },
  ));
}

// src/services/messaging/inboundSmsReply.service.js:146 — findByIdAndUpdate; predicate and write options are owned here.
export function linkReplyReview({ Conversation, reviewPatch, updatedConversation }) {
  return (Conversation.findByIdAndUpdate(updatedConversation._id,
      { $set: reviewPatch }, { returnDocument: 'after', runValidators: true }));
}

// src/services/messaging/inboundSmsReply.service.js:199 — findByIdAndUpdate; predicate and write options are owned here.
export function persistFailedHandoffDelivery({ Conversation, buildFailedHumanHandoffUpdate, error, inboundMessage, latestConversation, result, updatedConversation }) {
  return (Conversation.findByIdAndUpdate(
    updatedConversation._id,
    {
      $set: buildFailedHumanHandoffUpdate({
        inboundMessageId: inboundMessage._id,
        conversation: latestConversation,
        result,
        error,
      }),
      $inc: { "orchestration.silentFailureCount": 1 },
    },
    { returnDocument: "after", runValidators: true },
  ));
}

// src/services/messaging/inboundSmsReply.service.js:237 — findByIdAndUpdate; predicate and write options are owned here.
export function finalizeAcknowledgedHandoff({ Conversation, buildFinalizedHumanHandoffUpdate, delivery, deliveryStatus, inboundMessage, latestConversation, result, updatedConversation }) {
  return (Conversation.findByIdAndUpdate(
    updatedConversation._id,
    {
      $set: buildFinalizedHumanHandoffUpdate({
        inboundMessageId: inboundMessage._id,
        outboundMessageId: delivery?.message?._id || null,
        conversation: latestConversation,
        result,
        deliveryStatus,
      }),
    },
    { returnDocument: "after", runValidators: true },
  ));
}

// src/services/messaging/manualSmsOperation.service.js:202 — findOneAndUpdate; predicate and write options are owned here.
export function persistAcceptedManualSms({ Conversation, actorId, business, conversation, operation }) {
  return (Conversation.findOneAndUpdate(
    { _id: conversation._id, business: business._id },
    {
      $set: {
        aiEnabled: false,
        humanTakeover: true,
        humanTakeoverAt: new Date(),
        humanTakeoverBy: actorId,
        "orchestration.phase": "human_takeover",
        lastMessage: operation.metadata?.providerBody || operation.body,
        lastMessageAt: new Date(),
      },
    },
    { returnDocument: "after" },
  ));
}

// src/services/messaging/recoveryIntroduction.service.js:11 — findOneAndUpdate; predicate and write options are owned here.
export function claimConversationRecoveryIntroduction({ Conversation, businessId, conversationId, cutoff, now, operationKey }) {
  return (Conversation.findOneAndUpdate({
    _id: conversationId, business: businessId,
    status: 'open', humanTakeover: { $ne: true }, aiEnabled: { $ne: false },
    $or: [
      ...(operationKey ? [{ "orchestration.recoveryIntroOperationKey": operationKey }] : []),
      { 'orchestration.recoveryIntroClaimedAt': null },
      { 'orchestration.recoveryIntroClaimedAt': { $lte: cutoff } },
    ],
  }, { $set: { 'orchestration.recoveryIntroClaimedAt': now, ...(operationKey ? { 'orchestration.recoveryIntroOperationKey': operationKey } : {}) } }, { returnDocument: 'after' }));
}

// src/services/messaging/smsConversation.service.js:40 — findOneAndUpdate; predicate and write options are owned here.
export function upsertSmsLead({ Lead, body, businessId, customerPhone, source }) {
  return (Lead.findOneAndUpdate(
        { business: businessId, phoneLookup: customerPhone },
        {
          $setOnInsert: {
            business: businessId,
            customerName: source === "missed_call" ? "Missed Call Lead" : "New SMS Lead",
            phone: customerPhone,
            phoneLookup: customerPhone,
            serviceNeeded: "Unknown",
            urgency: "medium",
            source,
            status: source === "sms" ? "contacted" : "new",
            estimatedValue: null,
            valuation: { source: "unknown", basis: "Not estimated" },
            valuationVersion: 0,
            notes: body || (source === "sms" ? "MMS attachment received." : ""),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      ));
}

// src/services/messaging/smsConversation.service.js:81 — findByIdAndUpdate; predicate and write options are owned here.
export function updateSmsLead({ Lead, existing, updates }) {
  return (Lead.findByIdAndUpdate(existing._id, updates, {
      returnDocument: "after",
      runValidators: true,
    }));
}

// src/services/messaging/smsConversation.service.js:123 — findOneAndUpdate; predicate and write options are owned here.
export function reopenSmsConversation({ Conversation, body, businessId, customerPhone, lead, recoveryJourneyKey }) {
  return (Conversation.findOneAndUpdate(
        {
          business: businessId,
          customerPhoneLookup: customerPhone,
          activeRecord: true,
        },
        {
          $setOnInsert: {
            business: businessId,
            lead: lead._id,
            customerPhone,
            customerPhoneLookup: customerPhone,
            customerName: lead.customerName,
            status: "open",
            activeRecord: true,
            aiEnabled: true,
            humanTakeover: false,
            "orchestration.recoveryJourneyKey": String(recoveryJourneyKey || "").trim(),
            "orchestration.recoveryJourneyStartedAt": new Date(),
            lastMessage: body || "Attachment received",
            lastMessageAt: new Date(),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      ));
}

// src/services/messaging/smsConversation.service.js:173 — findByIdAndUpdate; predicate and write options are owned here.
export function updateSmsConversation({ Conversation, conversation, updates }) {
  return (Conversation.findByIdAndUpdate(conversation._id, updates, {
    returnDocument: "after",
    runValidators: true,
  }));
}

// src/services/messaging/smsConversation.service.js:180 — findOneAndUpdate; predicate and write options are owned here.
export function upsertSmsConversation({ Conversation, businessId, conversation }) {
  return (Conversation.findOneAndUpdate({
      _id: conversation._id, business: businessId, status: "closed",
      humanTakeover: { $ne: true }, aiEnabled: { $ne: false },
    }, { $set: { status: "open", reopenedAt: new Date(), reopenReason: "returning_customer_contact" } },
    { returnDocument: "after", runValidators: true }));
}

// src/services/messaging/smsConversationUpdateBatch.service.js:12 — findOneAndUpdate; predicate and write options are owned here.
export function updateSingleSmsSnapshot({ Conversation, row }) {
  return (Conversation.findOneAndUpdate(row.filter, row.update, { returnDocument: 'after', runValidators: true }));
}

// src/services/messaging/smsConversationUpdateBatch.service.js:15 — bulkWrite; predicate and write options are owned here.
export function updateSmsSnapshotBatch({ Conversation, rows, updates }) {
  return (Conversation.bulkWrite(rows.map((row,i) => ({ updateOne: { filter: row.filter, update: { $set: updates[i], $inc: { stateVersion: 1 } } } })), { ordered: false }));
}

// src/services/messaging/smsConversationUpdateBatch.service.js:27 — findByIdAndUpdate; predicate and write options are owned here.
export function updateLegacySmsSnapshot({ Conversation, conversationId, update }) {
  return (Conversation.findByIdAndUpdate(conversationId, update, { returnDocument: 'after', runValidators: true }));
}

// src/services/messaging/smsOutboundDelivery.adapter.js:227 — findByIdAndUpdate; predicate and write options are owned here.
export function persistOutboundConversationMessage({ Conversation, conversation, reply, sent }) {
  return (Conversation.findByIdAndUpdate(
      conversation._id,
      { lastMessage: sent?.body || reply, lastMessageAt: new Date() },
      { returnDocument: "after" },
    ));
}

// src/services/messaging/smsWorkflowPolicy.service.js:47 — assignment; predicate and write options are owned here.
export function stageRevisedRequestPatch({ changed, intake, lead, patch, result }) {
  return (patch['conversationMemory.recoveryIntake'] = { ...intake, submitted: false, reviewReady: false, availability: { status: 'not_checked', reason: 'request_changed' }, review: { status: 'update_required' }, activePreference: { label: result.preferredAppointmentTime || lead.preferredAppointmentTime || '' }, ...(changed.includes('preferredAppointmentTime') ? { date: '', time: '' } : {}) });
}

// src/services/messaging/trackedCallLink.service.js:29 — updateOne; predicate and write options are owned here.
export function linkTrackedLeadCalls({ Lead, businessId, earliest, leadId }) {
  return (Lead.updateOne({ _id: leadId, business: businessId, firstTrackingNumber: null, firstMarketingSource: null }, {
    $set: { firstMarketingSource: earliest.marketingSource || null,
      firstTrackingNumber: earliest.trackingNumber, firstAttribution: earliest.attribution || {} },
  }));
}

// src/services/messaging/uncertainReply.service.js:23 — set; predicate and write options are owned here.
export function setUncertainReplyMemory({ conversation, field, value }) {
  return (conversation.set(`conversationMemory.${field}`, value));
}

// src/services/messaging/uncertainReply.service.js:24 — assignment; predicate and write options are owned here.
export function replaceUncertainReplyMemory({ conversation, field, value }) {
  return (conversation.conversationMemory = { ...(conversation.conversationMemory || {}), [field]: value });
}

// A sent-message preview is a projection; never resave an older intake snapshot.
export function persistVoiceFallbackPreview({ Conversation, conversation, business, body, at }) {
  return Conversation.findOneAndUpdate({ _id: conversation._id, business: business._id,
    $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: at } }],
  }, { $set: { lastMessage: body, lastMessageAt: at } }, { returnDocument: 'after' });
}
