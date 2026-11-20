// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/voice/callback/notifications.js:30 — findOneAndUpdate; predicate and write options are owned here.
export function upsertCallbackReview({ Alert, businessId, canceled, clean, conversationId, dedupeKey, dueAtForPriority, isUsableCallerId, latestCustomerMessage, leadId, normalizeId, priority, session, state }) {
  return (Alert.findOneAndUpdate(
    { business: businessId, dedupeKey },
    {
      $setOnInsert: {
        business: businessId,
        lead: leadId,
        conversation: conversationId,
        type: state.alertType,
        channel: "in_app",
        title: canceled
          ? "Voice callback capture canceled"
          : priority === "critical"
            ? "Urgent voice safety escalation"
            : "Customer callback requested",
        message: canceled
          ? "The caller canceled before submitting the callback request. Partial details were retained for review."
          : priority === "critical"
            ? "A caller reported a potential emergency or safety risk. Review immediately, but the caller was told not to wait for a callback or use MeekCall instead of emergency services."
            : `MeekCall captured a callback request for ${state.serviceNeeded || "a customer inquiry"}.`,
        status: "pending",
        priority,
        actionRequired: !canceled,
        dueAt: canceled ? null : dueAtForPriority(priority),
        reason: canceled ? "caller_canceled_callback_capture" : state.reason,
        recommendedAction: canceled
          ? "Review only if the partial transcript indicates follow-up is appropriate."
          : priority === "critical"
            ? "Review the transcript immediately. Emergency services remain the caller's first action."
            : state.phone && isUsableCallerId(state.phone)
              ? "Review the captured details and contact the caller at the confirmed number."
              : "Review the captured details. No usable callback number was confirmed.",
        aiSummary: clean(
          `Service: ${state.serviceNeeded || "Not provided"}; name: ${state.customerName || "Not provided"}; location: ${state.location || "Not provided"}; urgency: ${state.urgencyDetail || state.urgency || "Not provided"}; preferred time: ${state.preferredTime || "Not provided"}; callback number: ${state.phone && isUsableCallerId(state.phone) ? "confirmed" : "not available"}.`,
          2000,
        ),
        lastCustomerMessage: clean(latestCustomerMessage(session), 1600),
        dedupeKey,
        metadata: {
          source: "voice_callback_capture",
          voiceSessionId: normalizeId(session),
          providerCallSid: session.providerCallSid || "",
          callbackCanceled: canceled,
          callbackDetails: {
            serviceNeeded: state.serviceNeeded,
            customerName: state.customerName,
            location: state.location,
            urgency: state.urgency,
            urgencyDetail: state.urgencyDetail,
            preferredTime: state.preferredTime,
            callbackPhoneConfirmed: Boolean(
              state.phone && isUsableCallerId(state.phone),
            ),
          },
        },
      },
    },
    { upsert: true, returnDocument: "after" },
  ));
}

// src/voice/callback/persistence.js:142 — assignment; predicate and write options are owned here.
export function stageCallbackLeadStatus({ lead }) {
  return (lead.status = lead.status || "new");
}

// src/voice/voiceFailure.service.js:48 — findOneAndUpdate; predicate and write options are owned here.
export function upsertVoiceFailureReview({ Alert, businessId, reason, session }) {
  return (Alert.findOneAndUpdate(
      {
        business: businessId,
        dedupeKey: `voice_failure:${session._id}`,
      },
      {
        $setOnInsert: {
          business: businessId,
          lead: session.lead?._id || session.lead || null,
          conversation:
            session.conversation?._id || session.conversation || null,
          type: "integration_failure",
          channel: "in_app",
          title: "Voice AI session failed",
          message:
            "The voice session failed. MeekCall preserved the partial transcript and started the configured staff-first recovery path.",
          status: "pending",
          priority: "high",
          actionRequired: true,
          reason: reason.slice(0, 1000),
          recommendedAction:
            "Answer the transfer or contact the caller immediately.",
          lastCustomerMessage:
            session.transcript
              ?.filter((entry) => entry.role === "customer")
              .at(-1)?.text || "",
          dedupeKey: `voice_failure:${session._id}`,
          metadata: { voiceSessionId: session._id },
        },
      },
      { upsert: true, returnDocument: "after" },
    ));
}

// src/voice/voiceHandoff.service.js:33 — set; predicate and write options are owned here.
export function stageVoiceHandoffPhase({ session }) {
  return (session.conversation.set("orchestration.phase", "handoff_pending"));
}

// src/voice/voiceHandoff.service.js:34 — set; predicate and write options are owned here.
export function stageVoiceHandoffAcknowledgement({ session }) {
  return (session.conversation.set("orchestration.handoffStatus", "pending_ack"));
}

// src/voice/voiceHandoff.service.js:35 — set; predicate and write options are owned here.
export function stageVoiceHandoffReason({ reason, session }) {
  return (session.conversation.set("orchestration.handoffReason", reason));
}

// src/voice/voiceHandoff.service.js:36 — set; predicate and write options are owned here.
export function stageVoiceHandoffTime({ session }) {
  return (session.conversation.set("orchestration.handoffRequestedAt", new Date()));
}

// src/voice/voiceHandoff.service.js:59 — findOneAndUpdate; predicate and write options are owned here.
export function upsertVoiceHandoffReview({ Alert, alertType, customerMessage, priority, reason, session, staffReviewDueAt }) {
  return (Alert.findOneAndUpdate(
      {
        business: session.business._id,
        dedupeKey: `voice_handoff:${session._id}:${reason}`,
      },
      {
        $setOnInsert: {
          business: session.business._id,
          lead: session.lead?._id || null,
          conversation: session.conversation?._id || null,
          type: alertType,
          channel: "in_app",
          title:
            priority === "critical"
              ? "Critical voice safety escalation"
              : "Voice caller needs a person",
          message:
            priority === "critical"
              ? "A voice caller reported a possible safety emergency. MeekCall preserved the context and requested a live handoff without assuming staff accepted it."
              : "The caller requested a person. MeekCall requested a screened live handoff and preserved the context; ownership is not assigned until staff accepts.",
          status: "pending",
          priority,
          actionRequired: true,
          dueAt: staffReviewDueAt(priority),
          reason,
          recommendedAction:
            "Accept the screened transfer if available; otherwise review the captured context. Do not assume the caller was promised a callback time.",
          lastCustomerMessage: customerMessage,
          dedupeKey: `voice_handoff:${session._id}:${reason}`,
          metadata: { voiceSessionId: session._id },
        },
      },
      { upsert: true, returnDocument: "after" },
    ));
}

// src/voice/voiceOutcome.service.js:102 — findByIdAndUpdate; predicate and write options are owned here.
export function persistVoiceOutcome({ Conversation, bookingTransitionFields, conversationId, now }) {
  return (Conversation.findByIdAndUpdate(
      conversationId,
      {
        $set: {
          aiEnabled: false,
          humanTakeover: true,
          humanTakeoverAt: now,
          humanTakeoverBy: null,
          ...bookingTransitionFields('voice_transfer_accepted'),
          "orchestration.phase": "human_takeover",
          "orchestration.handoffStatus": "acknowledged",
          "orchestration.handoffAcknowledgedAt": now,
        },
      },
      { returnDocument: "after" },
    ));
}

// src/voice/voiceSession.service.js:185 — create; predicate and write options are owned here.
export function createVoiceLead({ Lead, business, storedCaller, usableCaller }) {
  return (Lead.create({
          business: business._id,
          customerName: usableCaller ? "Voice Caller" : "Anonymous Voice Caller",
          phone: storedCaller,
          serviceNeeded: "Unknown",
          urgency: "medium",
          source: "voice",
          status: "new",
          estimatedValue: null,
          valuation: { source: "unknown", basis: "Not estimated" },
          valuationVersion: 0,
          notes: usableCaller
            ? "Lead created automatically from a MeekCall voice session."
            : "Lead created from a blocked or unavailable caller ID. Obtain and confirm a callback number before promising follow-up.",
        }));
}

// src/voice/voiceSession.service.js:216 — create; predicate and write options are owned here.
export function createVoiceConversation({ Conversation, business, lead, normalizedTo, storedCaller }) {
  return (Conversation.create({
          business: business._id,
          lead: lead._id,
          customerPhone: storedCaller,
          customerName: lead.customerName || "Voice Caller",
          status: "open",
          aiEnabled: true,
          humanTakeover: false,
          lastMessage: "Voice session started.",
          lastMessageAt: new Date(),
          replyFromPhone: normalizedTo || business.phone,
        }));
}

// src/voice/voiceSession.service.js:633 — findOneAndUpdate; predicate and write options are owned here.
export function upsertVoiceFallbackReview({ Alert, business, conversation, failureReason, lead, providerMessageId, session, suppressionReason }) {
  return (Alert.findOneAndUpdate(
        { business: business._id, dedupeKey: `voice_failure:${session._id}` },
        {
          $setOnInsert: {
            business: business._id,
            lead: lead?._id || null,
            conversation: conversation?._id || null,
            type: "integration_failure",
            channel: "in_app",
            title: "Voice AI session failed",
            message: suppressionReason
              ? `The voice session failed. The transcript was preserved, but SMS fallback was suppressed: ${suppressionReason}`
              : "The voice session failed. The transcript was preserved and the missed-call SMS fallback was attempted.",
            status: "pending",
            priority: "high",
            actionRequired: true,
            reason: String(failureReason || "Voice AI unavailable").slice(0, 1000),
            recommendedAction:
              "Review the partial transcript and contact the caller directly. For anonymous callers, review the call path because no callback number may be available.",
            lastCustomerMessage:
              session.transcript
                ?.filter((entry) => entry.role === "customer")
                .at(-1)?.text || "",
            dedupeKey: `voice_failure:${session._id}`,
            metadata: {
              voiceSessionId: session._id,
              providerCallSid: session.providerCallSid,
              fallbackSmsStatus: providerMessageId
                ? "sent"
                : suppressionReason
                  ? "suppressed"
                  : "failed",
            },
          },
        },
        { upsert: true, returnDocument: "after" },
      ));
}

// src/voice/voiceTurn/context.js:315 — assignment; predicate and write options are owned here.
export function stageVoiceLeadBooked({ lead }) {
  return (lead.status = "booked");
}

// src/voice/voiceTurn/routeConversationControl.js:23 — assignment; predicate and write options are owned here.
export function stageVoiceControlHandoff({ conversation }) {
  return (conversation.orchestration = { ...(conversation.orchestration?.toObject?.() || conversation.orchestration || {}),
          handoffReason: 'scheduling_review', phase: 'handoff_pending', handoffStatus: 'pending_ack' });
}
