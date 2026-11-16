// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/helpers/ai/tools/escalateToHuman.tool.js:13 — updateOne; predicate and write options are owned here.
export function escalateToHumanToolConversationUpdateOne({ Conversation, bookingTransitionFields, businessId, conversationId, reason }) {
  return (Conversation.updateOne(
    { _id: conversationId, business: businessId },
    {
      $set: {
        humanTakeover: true,
        aiEnabled: false,
        ...bookingTransitionFields('human_escalation_requested', { lastError: reason }),
      },
    },
  ));
}

// src/services/automation/automation.service.js:243 — create; predicate and write options are owned here.
export function automationExecuteAlertCreate({ Alert, body, populated }) {
  return (Alert.create({
          business: populated.business._id,
          lead: populated.lead?._id || null,
          conversation: populated.conversation._id,
          appointment: populated.appointment?._id || null,
          type: "unanswered_hot_lead",
          channel: "in_app",
          title: "Automated follow-up needs review",
          message: body || "This follow-up requires staff review.",
          status: "sent",
          priority: "medium",
          actionRequired: true,
          sentAt: new Date(),
        }));
}

// src/services/businessRequestWorkflow.service.js:239 — assignment; predicate and write options are owned here.
export function businessRequestWorkflowTransitionConversationFields({ conversationSet }) {
  return (conversationSet['conversationMemory.recoveryIntake.review.status']='resolved');
}

// src/services/businessRequestWorkflow.service.js:251 — assignment; predicate and write options are owned here.
export function businessRequestWorkflowTransitionConversationFields2({ conversationSet, id, resultId }) {
  return (conversationSet['conversationMemory.recoveryIntake.review.alertId']=id(resultId));
}

// src/services/businessRequestWorkflow.service.js:254 — assignment; predicate and write options are owned here.
export function businessRequestWorkflowTransitionConversationFields3({ conversationSet, now }) {
  return (conversationSet['conversationMemory.lastUpdatedAt']=now);
}

// src/services/conversationCondition.service.js:85 — set; predicate and write options are owned here.
export function conversationConditionObserveCustomerConstraintConversationMemory({ conversation, state }) {
  return (conversation.set('conversationMemory.recoveryIntake', state));
}

// src/services/conversationCondition.service.js:86 — assignment; predicate and write options are owned here.
export function conversationConditionObserveCustomerConstraintConversationFields({ conversation, state }) {
  return (conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: state });
}

// src/services/conversationControl.service.js:36 — assignment; predicate and write options are owned here.
export function handleConversationControlConversationFields({ conversation, memory, text }) {
  return (conversation.conversationMemory = { ...memory, recoveryIntake: {
      ...(memory.recoveryIntake || {}), journeyKey: conversation.orchestration?.recoveryJourneyKey || '',
      withdrawnAt: memory.recoveryIntake?.withdrawnAt || new Date(), withdrawalReason: text.slice(0, 500),
    } });
}

// src/services/conversationControl.service.js:41 — assignment; predicate and write options are owned here.
export function handleConversationControlConversationFields2({ conversation }) {
  return (conversation.lifecycle.nextRecoveryNudgeAt = null);
}

// src/services/conversationControl.service.js:65 — assignment; predicate and write options are owned here.
export function handleConversationControlLeadFields({ lead }) {
  return (lead.status = 'lost');
}

// src/services/conversationIntelligence.persistence.js:56 — findOneAndUpdate; predicate and write options are owned here.
export function conversationIntelligencePersistenceUpdateAnalyzedLeadLeadAtomicUpdate({ Lead, businessId, changes, lead }) {
  return (Lead.findOneAndUpdate({ _id: lead._id, business: businessId, updatedAt: lead.updatedAt },
    { $set: changes }, { returnDocument: 'after', runValidators: true }));
}

// src/services/conversationOrchestrator.service.js:82 — findByIdAndUpdate; predicate and write options are owned here.
export function conversationOrchestratorProcessConversationUpdateById({ Conversation, conversation }) {
  return (Conversation.findByIdAndUpdate(conversation._id, {
        $inc: { "orchestration.silentFailureCount": 1 },
        $set: { "orchestration.lastEscalatedAt": new Date() },
      }));
}

// src/services/conversationOrchestrator.service.js:97 — findByIdAndUpdate; predicate and write options are owned here.
export function conversationOrchestratorProcessConversationUpdateById2({ Conversation, conversation, inboundMessage, outcome, result }) {
  return (Conversation.findByIdAndUpdate(conversation._id, {
        $set: {
          ...(result?.summary ? { "conversationMemory.summary": String(result.summary).slice(0, 2000) } : {}),
          ...(outcome.serviceNeeded ? { "conversationMemory.serviceNeeded": outcome.serviceNeeded } : {}),
          ...(outcome.urgency ? { "conversationMemory.urgency": outcome.urgency } : {}),
          ...(outcome.address ? { "conversationMemory.address": outcome.address } : {}),
          ...(outcome.preferredAppointmentTime ? { "conversationMemory.preferredAppointmentTime": outcome.preferredAppointmentTime } : {}),
          "conversationMemory.lastIntent": outcome.intent,
          "conversationMemory.confidence": outcome.confidence,
          "conversationMemory.lastUpdatedAt": new Date(),
          "orchestration.lastOutcome": outcome.outcome,
          "orchestration.lastInboundMessage": inboundMessage._id,
        },
      }));
}

// src/services/conversationPolicy/dialogInterruption.js:46 — updateOne; predicate and write options are owned here.
export function dialogInterruptionMaybeAnswerDialogQuestionConversationUpdateOne({ Conversation, business, conversation, state }) {
  return (Conversation.updateOne({ _id: conversation._id, business: business._id,
    humanTakeover: { $ne: true }, aiEnabled: { $ne: false }, status: { $nin: ['closed','archived'] } },
    { $set: { 'conversationMemory.dialogPolicy': state } }));
}

// src/services/conversationPolicy/dialogInterruption.js:52 — assignment; predicate and write options are owned here.
export function dialogInterruptionMaybeAnswerDialogQuestionConversationFields({ conversation }) {
  return (conversation.conversationMemory = conversation.conversationMemory || {});
}

// src/services/conversationPolicy/dialogInterruption.js:53 — assignment; predicate and write options are owned here.
export function dialogInterruptionMaybeAnswerDialogQuestionConversationFields2({ conversation, state }) {
  return (conversation.conversationMemory.dialogPolicy = state);
}

// src/services/serviceEligibility/additionalServiceRequest.service.js:31 — set; predicate and write options are owned here.
export function preserveAdditionalServiceRequestConversationMemory({ conversation, next }) {
  return (conversation.set('conversationMemory.recoveryIntake', next));
}

// src/services/serviceEligibility/additionalServiceRequest.service.js:32 — assignment; predicate and write options are owned here.
export function preserveAdditionalServiceRequestConversationFields({ conversation, next }) {
  return (conversation.conversationMemory = { ...(conversation.conversationMemory || {}), recoveryIntake: next });
}

// src/services/serviceEligibility/serviceEligibility.service.js:143 — assignment; predicate and write options are owned here.
export function serviceEligibilityGuardServiceRequestConversationFields({ conversation, current, memory, prior, request }) {
  return (conversation.conversationMemory = { ...memory, recoveryIntake: current && prior?.request !== request ? {} : (memory.recoveryIntake || {}) });
}

// src/services/serviceEligibility/serviceEligibility.service.js:145 — assignment; predicate and write options are owned here.
export function serviceEligibilityGuardServiceRequestConversationFields2({ conversation, current, lead }) {
  return (conversation.conversationMemory.serviceNeeded = lead?.serviceNeeded || current);
}

// src/services/serviceEligibility/serviceEligibility.service.js:146 — assignment; predicate and write options are owned here.
export function serviceEligibilityGuardServiceRequestConversationFields3({ conversation, current, lead }) {
  return (conversation.conversationMemory.summary = lead?.serviceNeeded || current);
}

// src/services/serviceEligibility/serviceEligibility.service.js:149 — assignment; predicate and write options are owned here.
export function serviceEligibilityGuardServiceRequestConversationFields4({ conversation }) {
  return (conversation.lifecycle.nextRecoveryNudgeAt = null);
}

// src/services/serviceEligibility/serviceEligibility.service.js:186 — assignment; predicate and write options are owned here.
export function serviceEligibilityGuardServiceRequestConversationFields5({ conversation, nextMemory }) {
  return (conversation.conversationMemory = nextMemory);
}

// src/services/twilioSmsWebhook.service.js:118 — findByIdAndUpdate; predicate and write options are owned here.
export function twilioSmsWebhookUpdateConversationLastMessageConversationUpdateById({ Conversation, body, conversation }) {
  return (Conversation.findByIdAndUpdate(
    conversation._id,
    { lastMessage: body, lastMessageAt: new Date() },
    { returnDocument: "after" },
  ));
}

// src/services/twilioSmsWebhook.service.js:669 — findByIdAndUpdate; predicate and write options are owned here.
export function twilioSmsWebhookHandleInboundSmsWebhookConversationUpdateById({ Conversation, conversation, updates }) {
  return (Conversation.findByIdAndUpdate(
        conversation._id,
        updates,
        { returnDocument: "after" },
      ));
}

// src/services/voiceConversationTurn.service.js:29 — findOneAndUpdate; predicate and write options are owned here.
export function voiceConversationTurnOwnsVoiceIntakeConversationAtomicUpdate({ Conversation, businessId, conversation, owner, session }) {
  return (Conversation.findOneAndUpdate({
      _id: conversation._id, business: businessId,
      'orchestration.activeVoiceIntakeSession': owner || null,
    }, { $set: { 'orchestration.activeVoiceIntakeSession': session._id } }, { returnDocument: 'after' }));
}

// src/services/voiceConversationTurn.service.js:35 — assignment; predicate and write options are owned here.
export function voiceConversationTurnOwnsVoiceIntakeConversationFields({ conversation }) {
  return (conversation.orchestration = conversation.orchestration || {});
}

// src/services/voiceConversationTurn.service.js:36 — assignment; predicate and write options are owned here.
export function voiceConversationTurnOwnsVoiceIntakeConversationFields2({ conversation, session }) {
  return (conversation.orchestration.activeVoiceIntakeSession = session._id);
}

// src/services/voiceSafetyReview.service.js:47 — updateOne; predicate and write options are owned here.
export function voiceSafetyReviewTransitionLeadUpdateOne({ Lead, businessId, leadId, urgency }) {
  return (Lead.updateOne({ _id: leadId, business: businessId, urgency: { $ne: 'emergency' } }, { $set: { urgency } }));
}

// src/services/voiceSafetyReview.service.js:48 — updateOne; predicate and write options are owned here.
export function voiceSafetyReviewTransitionConversationUpdateOne({ Conversation, businessId, conversationId, urgency }) {
  return (Conversation.updateOne({ _id: conversationId, business: businessId, 'conversationMemory.urgency': { $ne: 'emergency' } },
      { $set: { 'conversationMemory.urgency': urgency } }));
}

// src/workers/conversationLifecycle.worker.js:88 — findOneAndUpdate; predicate and write options are owned here.
export function conversationLifecycleWorkerExpireBookingOfferConversationAtomicUpdate({ Conversation, bookingTransitionFields, conversation, expiresAt, now, status }) {
  return (Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      "bookingState.status": status,
      "bookingState.expiresAt": expiresAt,
      status: "open",
      humanTakeover: { $ne: true },
      aiEnabled: { $ne: false },
    },
    {
      $set: {
        ...bookingTransitionFields('offer_expired'),
        "orchestration.phase": "scheduling",
        "orchestration.lastStateTransitionAt": now,
      },
    },
    { returnDocument: "after" },
  ));
}

// src/workers/conversationLifecycle.worker.js:140 — findOneAndUpdate; predicate and write options are owned here.
export function conversationLifecycleWorkerNudgeAbandonedRecoveryConversationAtomicUpdate({ Conversation, conversation, nextCount, now, nudgeCount }) {
  return (Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      $or: [
        { "lifecycle.recoveryNudgeCount": nudgeCount },
        ...(nudgeCount === 0 ? [{ "lifecycle.recoveryNudgeCount": { $exists: false } }] : []),
      ],
    },
    {
      $set: {
        "lifecycle.recoveryNudgeCount": nextCount,
        "lifecycle.lastLifecycleActionAt": now,
        "lifecycle.nextRecoveryNudgeAt": nextCount >= 2 ? null : new Date(now.getTime() + 18 * 60 * 60000),
      },
    },
    { returnDocument: "after" },
  ));
}

// src/workers/conversationLifecycle.worker.js:171 — updateOne; predicate and write options are owned here.
export function conversationLifecycleWorkerNudgeAbandonedRecoveryConversationUpdateOne({ Conversation, conversation, nextCount, now, nudgeCount }) {
  return (Conversation.updateOne(
      { _id: conversation._id, "lifecycle.recoveryNudgeCount": nextCount },
      {
        $set: {
          "lifecycle.recoveryNudgeCount": nudgeCount,
          "lifecycle.nextRecoveryNudgeAt": new Date(now.getTime() + 60 * 60000),
        },
      },
    ));
}

// src/workers/conversationLifecycle.worker.js:191 — findOneAndUpdate; predicate and write options are owned here.
export function conversationLifecycleWorkerTransitionConversationAtomicUpdate({ Conversation, conversation, now }) {
  return (Conversation.findOneAndUpdate(
        { _id: conversation._id, status: "open" },
        { $set: { "lifecycle.lastScannedAt": now } },
        { returnDocument: "after" },
      ));
}
