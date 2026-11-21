// Named state transitions. Callers retain decision guards and side-effect order.
// Explicit capabilities preserve existing model binding, sessions, hooks and query laziness.

// src/services/conversionEvent.service.js:75 — updateOne; predicate and write options are owned here.
export function conversionEventMarkAppointmentBookedLeadUpdateOne({ Lead, appointment, lead, recovered, recoveredBy }) {
  return (Lead.updateOne(
        { _id: lead._id, business: appointment.business, $or: [{ bookedAt: null }, { bookedAt: { $lte: appointment.confirmedAt || new Date() } }] },
        {
          $set: {
            status: "booked",
            appointment: appointment._id,
            bookedAt: appointment.confirmedAt || new Date(),
            recovered,
            recoveredBy,
            // the booked service/appointment is the authoritative open value.

          },
        },
      ));
}

// src/services/customerLifecycle.service.js:29 — updateOne; predicate and write options are owned here.
export function syncCustomerLifecycleLeadUpdateOne({ Lead, businessId, customerLifecycleStatus, leadId }) {
  return (Lead.updateOne(
      { _id: leadId, business: businessId },
      { $set: { customerLifecycleStatus } },
    ));
}

// src/services/customerLifecycle.service.js:34 — updateMany; predicate and write options are owned here.
export function syncCustomerLifecycleConversationUpdateMany({ Conversation, businessId, conversationIds, customerLifecycleStatus }) {
  return (Conversation.updateMany(
          { _id: { $in: conversationIds }, business: businessId },
          { $set: { customerLifecycleStatus } },
        ));
}

// src/services/customerLifecycle.service.js:40 — updateMany; predicate and write options are owned here.
export function syncCustomerLifecycleAppointmentUpdateMany({ Appointment, appointmentIds, businessId, customerLifecycleStatus }) {
  return (Appointment.updateMany(
          { _id: { $in: appointmentIds }, business: businessId },
          { $set: { customerLifecycleStatus } },
        ));
}

// src/services/customerLifecycle.service.js:51 — updateMany; predicate and write options are owned here.
export function syncCustomerLifecycleAlertUpdateMany({ Alert, appointmentIds, businessId, conversationIds, customerLifecycleStatus, leadId }) {
  return (Alert.updateMany(
      {
        business: businessId,
        $or: [
          { lead: leadId },
          ...(conversationIds.length ? [{ conversation: { $in: conversationIds } }] : []),
          ...(appointmentIds.length ? [{ appointment: { $in: appointmentIds } }] : []),
        ],
      },
      { $set: { customerLifecycleStatus } },
    ));
}

// src/services/marketingAttribution.service.js:127 — updateOne; predicate and write options are owned here.
export function marketingAttributionTransitionLeadUpdateOne({ Lead, attribution, businessId, earliestCall, leadId, marketingSource, trackingNumber }) {
  return (Lead.updateOne(
              {
                _id: leadId,
                business: businessId,
                $or: [
                  { firstTrackingNumber: null },
                  { firstTrackingNumber: { $exists: false } },
                ],
              },
              {
                $set: {
                  firstMarketingSource:
                    earliestCall?.marketingSource || marketingSource?._id || null,
                  firstTrackingNumber:
                    earliestCall?.trackingNumber || trackingNumber._id,
                  firstAttribution:
                    earliestCall?.attribution || attribution,
                },
              },
            ));
}

// src/services/marketingAttribution.service.js:150 — updateOne; predicate and write options are owned here.
export function marketingAttributionTransitionLeadUpdateOne2({ Lead, attribution, businessId, leadId, marketingSource, trackingNumber }) {
  return (Lead.updateOne(
          { _id: leadId, business: businessId },
          {
            $set: {
              latestMarketingSource: marketingSource?._id || null,
              latestTrackingNumber: trackingNumber?._id || null,
              latestAttribution: attribution,
            },
          },
        ));
}

// src/services/marketingAttribution.service.js:166 — updateOne; predicate and write options are owned here.
export function marketingAttributionSyncLatestAttributionConversationUpdateOne({ Conversation, attribution, businessId, conversationId, marketingSource, replyFromPhone, trackingNumber }) {
  return (Conversation.updateOne(
        { _id: conversationId, business: businessId },
        {
          $set: {
            latestMarketingSource: marketingSource?._id || null,
            latestTrackingNumber: trackingNumber?._id || null,
            latestAttribution: attribution,
            ...(replyFromPhone ? { replyFromPhone } : {}),
          },
        },
      ));
}

// src/services/valuation/opportunityValuation.service.js:16 — findOneAndUpdate; predicate and write options are owned here.
export function opportunityValuationReserveValuationLeadAtomicUpdate({ Lead, businessId, lead, unknownEstimate, versionClaim = {} }) {
  return (Lead.findOneAndUpdate({ _id: lead._id, business: businessId, ...versionClaim,
      "valuation.source": { $exists: false }, estimatedValue: null,
    }, { $set: { valuation: unknownEstimate().valuation }, $inc: { valuationVersion: 1 } }, { returnDocument: "after" }));
}

// src/services/valuation/opportunityValuation.service.js:21 — findOneAndUpdate; predicate and write options are owned here.
export function opportunityValuationReserveValuationLeadAtomicUpdate2({ Lead, businessId, lead, versionClaim = {} }) {
  return (Lead.findOneAndUpdate({ _id: lead._id, business: businessId, ...versionClaim,
    "valuation.source": { $in: ["unknown", "service_catalog", "historical"] },
  }, { $inc: { valuationVersion: 1 } }, { returnDocument: "after" }));
}

// src/services/valuation/opportunityValuation.service.js:30 — findOneAndUpdate; predicate and write options are owned here.
export function opportunityValuationCommitValuationLeadAtomicUpdate({ Lead, businessId, ticket, value }) {
  return (Lead.findOneAndUpdate({ _id: ticket._id, business: businessId,
    valuationVersion: ticket.valuationVersion,
    "serviceEligibility.decision": { $nin: ["unsupported", "needs_clarification", "needs_staff_review"] },
    "valuation.source": { $in: ["unknown", "service_catalog", "historical"] },
  }, { $set: value, $inc: { valuationVersion: 1 } }, { returnDocument: "after", runValidators: true }));
}

// src/services/valuation/opportunityValuation.service.js:52 — findOneAndUpdate; predicate and write options are owned here.
export function opportunityValuationUpdateOwnerLeadLeadAtomicUpdate({ Lead, businessId, lead, update }) {
  return (Lead.findOneAndUpdate({ _id: lead._id, business: businessId }, update,
    { returnDocument: "after", runValidators: true }));
}


export function preserveConversationReplyNumber({ Conversation, businessId, conversationId, replyFromPhone }) {
  return Conversation.updateOne({ _id: conversationId, business: businessId }, { $set: { replyFromPhone } });
}
