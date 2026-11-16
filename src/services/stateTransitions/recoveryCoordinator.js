// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/recoveryCoordinator/reconciliation.service.js:30 — findOneAndUpdate; predicate and write options are owned here.
export function persistRecoveryBookingEvidence({ RecoveryCase, appointment, now, record, session }) {
  return (RecoveryCase.findOneAndUpdate({_id:record._id,business:record.business,
            version:record.version,status:{$in:['accepted','scheduling']}},{$set:{status:'booked',
              'booking.appointment':appointment._id,'booking.status':'confirmed','booking.lastVerifiedAt':now},
              $inc:{version:1}},{new:true,session}));
}

// src/services/recoveryCoordinator/recoveryCoordinator.service.js:33 — findOneAndUpdate; predicate and write options are owned here.
export function initializeRecoverySnapshot({ RecoveryCase, businessId, conversation, facts, lead }) {
  return (RecoveryCase.findOneAndUpdate({business:businessId,conversation:conversation._id,generation:1},
      {$setOnInsert:{business:businessId,conversation:conversation._id,lead:lead._id,generation:1,version:0,
        status:conversation.serviceEligibility?.decision==='needs_staff_review' ? 'needs_review' : 'qualifying',facts,
        serviceDecision:{decision:'pending'},source:{leadUpdatedAt:lead.updatedAt,conversationUpdatedAt:conversation.updatedAt}}},
      {upsert:true,new:true,runValidators:true}));
}

// src/services/recoveryCoordinator/recoveryCoordinator.service.js:86 — updateOne; predicate and write options are owned here.
export function writeRecoveryLeadFacts({ Lead, businessId, input, record, session }) {
  return (Lead.updateOne({_id:record.lead,business:businessId},{$set:input},{session,runValidators:true}));
}

// src/services/recoveryCoordinator/recoveryCoordinator.service.js:91 — updateOne; predicate and write options are owned here.
export function writeRecoveryConversationFacts({ Conversation, businessId, conversationId, session, update }) {
  return (Conversation.updateOne({_id:conversationId,business:businessId},{$set:update},{session,runValidators:true}));
}

// src/services/recoveryCoordinator/recoveryCoordinator.service.js:112 — findOneAndUpdate; predicate and write options are owned here.
export function advanceRecoveryDecision({ RecoveryCase, businessId, next, record, session, version }) {
  return (RecoveryCase.findOneAndUpdate({_id:record._id,business:businessId,version},
      {$set:next,$inc:{version:1}},{new:true,runValidators:true,session}));
}
// src/services/recoveryCoordinator/reconciliation.service.js:33 — create.
export function recordRecoveryBookingEvent({ RecoveryEvent, appointment, hash, key, record, session }) {
  return (RecoveryEvent.create([{business:record.business,recoveryCase:record._id,conversation:record.conversation,
            operationId:key,operationHash:hash,kind:'booking_observed',versionBefore:record.version,
            versionAfter:record.version+1,evidence:{appointmentId:String(appointment._id)}}],{session}));
}

// src/services/recoveryCoordinator/recoveryCoordinator.service.js:110 — create.
export function recordRecoveryOperationEvent({ RecoveryEvent, action, businessId, evidence, input, operationHash, operationId, record, session, userId, version }) {
  return (RecoveryEvent.create([{business:businessId,recoveryCase:record._id,conversation:record.conversation,
      operationId,operationHash,kind:action==='facts'?'facts_corrected':input.decision==='accepted'?'service_accepted':'service_declined',
      versionBefore:version,versionAfter:version+1,actor:userId,evidence}],{session}));
}

